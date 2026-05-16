// Voice input bar — compact mic toggle for watchOS

import SwiftUI

struct VoiceInputBar: View {
    @ObservedObject var voiceService: VoiceService
    let onSend: (String) -> Void

    var body: some View {
        HStack(spacing: 8) {
            // Cancel (visible while recording)
            if voiceService.isRecording {
                Button {
                    voiceService.cancelRecording()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .frame(width: 24, height: 24)
            }

            // Partial transcript
            if voiceService.isRecording && !voiceService.partialTranscript.isEmpty {
                Text(voiceService.partialTranscript)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if !voiceService.isRecording {
                Spacer()
            }

            // Mic button
            Button {
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
                Image(systemName: voiceService.isRecording ? "stop.fill" : "mic.fill")
                    .font(.caption)
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(voiceService.isRecording ? Color.red : Color.blue)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }
}
