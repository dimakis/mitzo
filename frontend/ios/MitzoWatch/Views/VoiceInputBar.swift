// Voice input bar — push-to-talk with live transcript

import SwiftUI

struct VoiceInputBar: View {
    @ObservedObject var voiceService: VoiceService
    let onSend: (String) -> Void

    var body: some View {
        VStack(spacing: 4) {
            // Partial transcript
            if !voiceService.partialTranscript.isEmpty {
                Text(voiceService.partialTranscript)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
            }

            HStack(spacing: 12) {
                // Cancel (visible while recording)
                if voiceService.isRecording {
                    Button {
                        voiceService.cancelRecording()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }

                // Mic button — hold to talk
                Button {
                    // Toggle behavior for watch (long press is awkward)
                    if voiceService.isRecording {
                        voiceService.stopRecording { transcript in
                            if !transcript.isEmpty {
                                onSend(transcript)
                            }
                        }
                    } else {
                        voiceService.startRecording()
                    }
                } label: {
                    ZStack {
                        Circle()
                            .fill(voiceService.isRecording ? Color.red : Color.blue)
                            .frame(width: 44, height: 44)

                        Image(systemName: voiceService.isRecording ? "stop.fill" : "mic.fill")
                            .font(.body)
                            .foregroundStyle(.white)
                    }
                }
                .buttonStyle(.plain)

                // Recording indicator
                if voiceService.isRecording {
                    Circle()
                        .fill(.red)
                        .frame(width: 8, height: 8)
                        .opacity(voiceService.isRecording ? 1 : 0)
                        .animation(.easeInOut(duration: 0.5).repeatForever(), value: voiceService.isRecording)
                }
            }
            .padding(.vertical, 6)
        }
    }
}
