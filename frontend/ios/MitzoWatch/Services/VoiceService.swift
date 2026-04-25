// Voice capture service — AVAudioEngine → Yapper STT

import AVFoundation
import MitzoShared

@MainActor
final class VoiceService: ObservableObject {
    @Published var isRecording = false
    @Published var partialTranscript = ""
    @Published var isYapperAvailable = false

    private var audioEngine: AVAudioEngine?
    private var yapperClient: YapperClient?
    private var finalTranscript = ""
    private var completionHandler: ((String) -> Void)?

    // Yapper URL — same Tailscale network
    var yapperURL: URL {
        URL(string: "http://mitzo.tail:8700")!
    }

    init() {
        yapperClient = YapperClient(baseURL: yapperURL)
        Task { await checkYapper() }
    }

    // MARK: - Health

    func checkYapper() async {
        do {
            isYapperAvailable = try await yapperClient?.checkHealth() ?? false
        } catch {
            isYapperAvailable = false
        }
    }

    // MARK: - Recording

    func startRecording() {
        guard !isRecording else { return }

        partialTranscript = ""
        finalTranscript = ""

        Task {
            do {
                // Request mic permission
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.record, mode: .measurement)
                try session.setActive(true)

                // Start Yapper streaming
                try await yapperClient?.startStreaming { [weak self] event in
                    Task { @MainActor in
                        self?.handleTranscriptEvent(event)
                    }
                }

                // Start audio engine
                let engine = AVAudioEngine()
                let inputNode = engine.inputNode
                let format = AVAudioFormat(
                    commonFormat: .pcmFormatInt16,
                    sampleRate: 16000,
                    channels: 1,
                    interleaved: true
                )!

                // Install tap
                let busFormat = inputNode.outputFormat(forBus: 0)
                let converter = AVAudioConverter(from: busFormat, to: format)!

                inputNode.installTap(onBus: 0, bufferSize: 4096, format: busFormat) { [weak self] buffer, _ in
                    // Convert to PCM int16 16kHz mono
                    let frameCount = AVAudioFrameCount(
                        Double(buffer.frameLength) * 16000.0 / busFormat.sampleRate
                    )
                    guard let convertedBuffer = AVAudioPCMBuffer(
                        pcmFormat: format,
                        frameCapacity: frameCount
                    ) else { return }

                    var error: NSError?
                    converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                        outStatus.pointee = .haveData
                        return buffer
                    }

                    if let channelData = convertedBuffer.int16ChannelData {
                        let data = Data(
                            bytes: channelData[0],
                            count: Int(convertedBuffer.frameLength) * 2
                        )

                        Task {
                            try? await self?.yapperClient?.sendAudio(data)
                        }
                    }
                }

                try engine.start()
                audioEngine = engine
                isRecording = true

            } catch {
                isRecording = false
            }
        }
    }

    func stopRecording(completion: @escaping (String) -> Void) {
        guard isRecording else {
            completion("")
            return
        }

        completionHandler = completion
        isRecording = false

        // Stop audio engine
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil

        // Signal end to Yapper
        Task {
            try? await yapperClient?.endStreaming()

            // Wait a moment for final transcript, then deliver
            try? await Task.sleep(nanoseconds: 2_000_000_000)

            let transcript = finalTranscript.isEmpty ? partialTranscript : finalTranscript
            completionHandler?(transcript)
            completionHandler = nil
            partialTranscript = ""
        }
    }

    func cancelRecording() {
        isRecording = false
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        partialTranscript = ""
        finalTranscript = ""

        Task {
            await yapperClient?.close()
        }
    }

    // MARK: - Transcript Events

    private func handleTranscriptEvent(_ event: YapperClient.TranscriptEvent) {
        switch event {
        case .partial(let text):
            partialTranscript = text

        case .final(let text):
            finalTranscript = text
            partialTranscript = text

            // If completion handler is waiting, deliver immediately
            if let handler = completionHandler {
                handler(text)
                completionHandler = nil
            }

        case .error:
            break
        }
    }
}
