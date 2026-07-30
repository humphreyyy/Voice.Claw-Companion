import SwiftUI

enum VoiceClawCompanionTheme {
    static let background = Color(red: 3.0 / 255.0, green: 9.0 / 255.0, blue: 14.0 / 255.0)
    static let backgroundElevated = Color(red: 6.0 / 255.0, green: 20.0 / 255.0, blue: 29.0 / 255.0)
    static let backgroundTeal = Color(red: 8.0 / 255.0, green: 43.0 / 255.0, blue: 56.0 / 255.0)
    static let surface = Color(red: 11.0 / 255.0, green: 29.0 / 255.0, blue: 40.0 / 255.0)
    static let surfaceStrong = Color(red: 16.0 / 255.0, green: 42.0 / 255.0, blue: 55.0 / 255.0)

    static let primaryText = Color(red: 247.0 / 255.0, green: 251.0 / 255.0, blue: 1.0)
    static let secondaryText = Color(red: 194.0 / 255.0, green: 208.0 / 255.0, blue: 217.0 / 255.0)
    static let mutedText = Color(red: 143.0 / 255.0, green: 162.0 / 255.0, blue: 175.0 / 255.0)

    static let cyan = Color(red: 85.0 / 255.0, green: 228.0 / 255.0, blue: 242.0 / 255.0)
    static let green = Color(red: 158.0 / 255.0, green: 245.0 / 255.0, blue: 139.0 / 255.0)
    static let amber = Color(red: 1.0, green: 206.0 / 255.0, blue: 105.0 / 255.0)
    static let coral = Color(red: 1.0, green: 118.0 / 255.0, blue: 93.0 / 255.0)
    static let violet = Color(red: 157.0 / 255.0, green: 134.0 / 255.0, blue: 1.0)

    static let line = Color.white.opacity(0.12)
    static let lineStrong = cyan.opacity(0.32)
    static let subtleFill = Color.white.opacity(0.055)

    static var canvasGradient: LinearGradient {
        LinearGradient(
            colors: [
                background,
                backgroundElevated,
                backgroundTeal.opacity(0.82),
                background,
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    static var heroGradient: LinearGradient {
        LinearGradient(
            colors: [
                backgroundElevated,
                backgroundTeal.opacity(0.92),
                Color(red: 9.0 / 255.0, green: 22.0 / 255.0, blue: 54.0 / 255.0),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

struct VoiceClawCompanionBackdrop: View {
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                VoiceClawCompanionTheme.canvasGradient

                signalLine(
                    phase: 0.1,
                    colors: [
                        VoiceClawCompanionTheme.cyan.opacity(0),
                        VoiceClawCompanionTheme.cyan.opacity(0.18),
                        VoiceClawCompanionTheme.green.opacity(0.12),
                        VoiceClawCompanionTheme.green.opacity(0),
                    ],
                    width: geometry.size.width * 0.92,
                    height: 170
                )
                .offset(
                    x: geometry.size.width * 0.17,
                    y: -geometry.size.height * 0.31
                )

                signalLine(
                    phase: 1.55,
                    colors: [
                        VoiceClawCompanionTheme.violet.opacity(0),
                        VoiceClawCompanionTheme.violet.opacity(0.12),
                        VoiceClawCompanionTheme.coral.opacity(0.10),
                        VoiceClawCompanionTheme.coral.opacity(0),
                    ],
                    width: geometry.size.width * 0.82,
                    height: 150
                )
                .offset(
                    x: -geometry.size.width * 0.22,
                    y: geometry.size.height * 0.35
                )
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func signalLine(
        phase: CGFloat,
        colors: [Color],
        width: CGFloat,
        height: CGFloat
    ) -> some View {
        CompanionSignalLine(phase: phase)
            .stroke(
                LinearGradient(
                    colors: colors,
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                style: StrokeStyle(lineWidth: 1.2, lineCap: .round)
            )
            .frame(width: width, height: height)
    }
}

struct VoiceClawSignalWaveform: View {
    var intensity: Double = 1

    private let levels: [CGFloat] = [
        0.30, 0.54, 0.72, 0.42, 0.88, 0.62, 1.00, 0.68, 0.46, 0.82, 0.56, 0.34,
    ]

    var body: some View {
        GeometryReader { geometry in
            let availableHeight = max(1, geometry.size.height)
            let barWidth = max(3, min(6, geometry.size.width / 30))
            let spacing = max(3, min(6, geometry.size.width / 27))

            HStack(alignment: .center, spacing: spacing) {
                ForEach(Array(levels.enumerated()), id: \.offset) { index, level in
                    RoundedRectangle(cornerRadius: barWidth / 2, style: .continuous)
                        .fill(barGradient(for: index))
                        .frame(
                            width: barWidth,
                            height: max(8, availableHeight * level * intensity)
                        )
                        .shadow(
                            color: glowColor(for: index).opacity(0.28),
                            radius: 8
                        )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityHidden(true)
    }

    private func barGradient(for index: Int) -> LinearGradient {
        LinearGradient(
            colors: [
                index.isMultiple(of: 2)
                    ? VoiceClawCompanionTheme.cyan
                    : VoiceClawCompanionTheme.green,
                index.isMultiple(of: 3)
                    ? VoiceClawCompanionTheme.coral
                    : VoiceClawCompanionTheme.violet,
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    private func glowColor(for index: Int) -> Color {
        index.isMultiple(of: 2)
            ? VoiceClawCompanionTheme.cyan
            : VoiceClawCompanionTheme.green
    }
}

struct VoiceClawCompanionLogoMark: View {
    var size: CGFloat = 52

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .fill(VoiceClawCompanionTheme.heroGradient)
                .overlay {
                    RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                        .stroke(
                            VoiceClawCompanionTheme.cyan.opacity(0.34),
                            lineWidth: max(1, size * 0.018)
                        )
                }

            CompanionClawShellShape()
                .fill(
                    LinearGradient(
                        colors: [
                            VoiceClawCompanionTheme.primaryText,
                            VoiceClawCompanionTheme.cyan.opacity(0.90),
                            VoiceClawCompanionTheme.violet.opacity(0.86),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay {
                    CompanionClawShellShape()
                        .stroke(
                            VoiceClawCompanionTheme.primaryText.opacity(0.74),
                            lineWidth: max(1, size * 0.028)
                        )
                }
                .frame(width: size * 0.50, height: size * 0.68)
                .offset(x: -size * 0.20, y: size * 0.02)
                .shadow(
                    color: VoiceClawCompanionTheme.cyan.opacity(0.32),
                    radius: size * 0.08,
                    x: -size * 0.02,
                    y: size * 0.04
                )

            CompanionClawShellShape()
                .fill(
                    LinearGradient(
                        colors: [
                            VoiceClawCompanionTheme.primaryText.opacity(0.94),
                            VoiceClawCompanionTheme.cyan.opacity(0.86),
                            VoiceClawCompanionTheme.violet.opacity(0.84),
                        ],
                        startPoint: .topTrailing,
                        endPoint: .bottomLeading
                    )
                )
                .overlay {
                    CompanionClawShellShape()
                        .stroke(
                            VoiceClawCompanionTheme.primaryText.opacity(0.68),
                            lineWidth: max(1, size * 0.028)
                        )
                }
                .scaleEffect(x: -1, y: 1)
                .frame(width: size * 0.50, height: size * 0.68)
                .offset(x: size * 0.20, y: size * 0.02)
                .shadow(
                    color: VoiceClawCompanionTheme.cyan.opacity(0.28),
                    radius: size * 0.08,
                    x: size * 0.02,
                    y: size * 0.04
                )

            CompanionVoiceBaseBars(size: size)
                .offset(y: size * 0.25)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct CompanionSignalLine: Shape {
    let phase: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let centerY = rect.midY
        let amplitude = rect.height * 0.27
        var x: CGFloat = 0

        while x <= rect.width {
            let progress = rect.width > 0 ? x / rect.width : 0
            let envelope = sin(progress * .pi)
            let primaryWave = sin(Double(progress * .pi * 6 + phase))
            let secondaryWave = sin(Double(progress * .pi * 14 + phase * 0.7))
            let y = centerY
                + CGFloat(primaryWave) * amplitude * envelope
                + CGFloat(secondaryWave) * amplitude * 0.12

            if x == 0 {
                path.move(to: CGPoint(x: x, y: y))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
            x += 5
        }

        return path
    }
}

private struct CompanionClawShellShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let width = rect.width
        let height = rect.height

        path.move(to: CGPoint(x: width * 0.72, y: height * 0.97))
        path.addCurve(
            to: CGPoint(x: width * 0.18, y: height * 0.70),
            control1: CGPoint(x: width * 0.44, y: height * 0.94),
            control2: CGPoint(x: width * 0.22, y: height * 0.86)
        )
        path.addCurve(
            to: CGPoint(x: width * 0.26, y: height * 0.12),
            control1: CGPoint(x: width * 0.08, y: height * 0.42),
            control2: CGPoint(x: width * 0.12, y: height * 0.22)
        )
        path.addCurve(
            to: CGPoint(x: width * 0.64, y: height * 0.05),
            control1: CGPoint(x: width * 0.36, y: height * 0.04),
            control2: CGPoint(x: width * 0.52, y: height * 0.02)
        )
        path.addCurve(
            to: CGPoint(x: width * 0.80, y: height * 0.36),
            control1: CGPoint(x: width * 0.74, y: height * 0.12),
            control2: CGPoint(x: width * 0.82, y: height * 0.23)
        )
        path.addCurve(
            to: CGPoint(x: width * 0.68, y: height * 0.53),
            control1: CGPoint(x: width * 0.79, y: height * 0.43),
            control2: CGPoint(x: width * 0.74, y: height * 0.49)
        )
        path.addCurve(
            to: CGPoint(x: width * 0.88, y: height * 0.78),
            control1: CGPoint(x: width * 0.82, y: height * 0.59),
            control2: CGPoint(x: width * 0.91, y: height * 0.68)
        )
        path.addCurve(
            to: CGPoint(x: width * 0.72, y: height * 0.97),
            control1: CGPoint(x: width * 0.85, y: height * 0.88),
            control2: CGPoint(x: width * 0.78, y: height * 0.94)
        )
        path.closeSubpath()

        return path
    }
}

private struct CompanionVoiceBaseBars: View {
    let size: CGFloat

    private let heights: [CGFloat] = [0.18, 0.28, 0.42, 0.34, 0.22]

    var body: some View {
        HStack(alignment: .bottom, spacing: size * 0.032) {
            ForEach(Array(heights.enumerated()), id: \.offset) { index, height in
                Capsule(style: .continuous)
                    .fill(fill(for: index))
                    .frame(width: size * 0.052, height: size * height)
                    .shadow(
                        color: VoiceClawCompanionTheme.cyan.opacity(0.22),
                        radius: size * 0.04
                    )
            }
        }
    }

    private func fill(for index: Int) -> LinearGradient {
        LinearGradient(
            colors: [
                index == 2
                    ? VoiceClawCompanionTheme.amber
                    : VoiceClawCompanionTheme.primaryText,
                index == 2
                    ? VoiceClawCompanionTheme.primaryText
                    : VoiceClawCompanionTheme.cyan,
                VoiceClawCompanionTheme.violet,
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

private struct CompanionPanelSurfaceModifier: ViewModifier {
    let accent: Color?

    func body(content: Content) -> some View {
        content
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                VoiceClawCompanionTheme.surface.opacity(0.94),
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(VoiceClawCompanionTheme.line, lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .overlay(alignment: .topLeading) {
                if let accent {
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [accent, accent.opacity(0.18)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(height: 2)
                        .padding(.horizontal, 8)
                        .allowsHitTesting(false)
                }
            }
            .shadow(color: .black.opacity(0.22), radius: 12, y: 6)
    }
}

private struct CompanionHeroSurfaceModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                VoiceClawCompanionTheme.heroGradient,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(VoiceClawCompanionTheme.lineStrong, lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .shadow(
                color: VoiceClawCompanionTheme.cyan.opacity(0.08),
                radius: 18,
                y: 8
            )
    }
}

private struct CompanionInsetSurfaceModifier: ViewModifier {
    let accent: Color?

    func body(content: Content) -> some View {
        content
            .padding(14)
            .background(
                VoiceClawCompanionTheme.subtleFill,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(
                        accent?.opacity(0.24) ?? VoiceClawCompanionTheme.line,
                        lineWidth: 1
                    )
                    .allowsHitTesting(false)
            }
    }
}

private struct CompanionStatusSurfaceModifier: ViewModifier {
    let color: Color

    func body(content: Content) -> some View {
        content
            .padding(14)
            .background(
                VoiceClawCompanionTheme.surfaceStrong.opacity(0.68),
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(color.opacity(0.055))
                    .allowsHitTesting(false)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(color.opacity(0.34), lineWidth: 1)
                    .allowsHitTesting(false)
            }
    }
}

extension View {
    func companionPanelSurface(accent: Color? = nil) -> some View {
        modifier(CompanionPanelSurfaceModifier(accent: accent))
    }

    func companionHeroSurface() -> some View {
        modifier(CompanionHeroSurfaceModifier())
    }

    func companionInsetSurface(accent: Color? = nil) -> some View {
        modifier(CompanionInsetSurfaceModifier(accent: accent))
    }

    func companionStatusSurface(color: Color) -> some View {
        modifier(CompanionStatusSurfaceModifier(color: color))
    }
}
