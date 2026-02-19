import SwiftUI
import AVFoundation

struct QRScannerView: View {
    var onScanned: (_ serverBaseURL: String, _ token: String) -> Void

    @State private var cameraDenied = false

    var body: some View {
        ZStack {
            CameraPreview(onCodeScanned: handleCode)
                .ignoresSafeArea()

            VStack {
                Spacer()
                Text("Scan QR code to connect")
                    .font(.headline)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .padding(.bottom, 80)
            }

            if cameraDenied {
                VStack(spacing: 16) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)
                    Text("Camera access is required to scan the QR code.")
                        .multilineTextAlignment(.center)
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.background)
            }
        }
        .task {
            let status = AVCaptureDevice.authorizationStatus(for: .video)
            if status == .denied || status == .restricted {
                cameraDenied = true
            } else if status == .notDetermined {
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                cameraDenied = !granted
            }
        }
    }

    private func handleCode(_ code: String) {
        guard let comps = URLComponents(string: code),
              let scheme = comps.scheme,
              ["http", "https"].contains(scheme),
              let host = comps.host else { return }

        let token = comps.queryItems?.first(where: { $0.name == "token" })?.value ?? ""
        var baseComps = URLComponents()
        baseComps.scheme = scheme
        baseComps.host = host
        if let port = comps.port { baseComps.port = port }
        let baseURL = baseComps.string ?? code

        onScanned(baseURL, token)
    }
}

// MARK: - AVFoundation camera preview

private struct CameraPreview: UIViewRepresentable {
    let onCodeScanned: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCodeScanned: onCodeScanned)
    }

    func makeUIView(context: Context) -> PreviewUIView {
        let view = PreviewUIView()
        let session = AVCaptureSession()
        context.coordinator.session = session

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return view }

        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return view }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(context.coordinator, queue: .main)
        output.metadataObjectTypes = [.qr]

        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        view.previewLayer = previewLayer
        view.layer.addSublayer(previewLayer)

        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }

        return view
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {}

    static func dismantleUIView(_ uiView: PreviewUIView, coordinator: Coordinator) {
        coordinator.session?.stopRunning()
    }

    class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        var session: AVCaptureSession?
        let onCodeScanned: (String) -> Void
        private var didScan = false

        init(onCodeScanned: @escaping (String) -> Void) {
            self.onCodeScanned = onCodeScanned
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !didScan,
                  let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let value = object.stringValue else { return }
            didScan = true
            session?.stopRunning()
            onCodeScanned(value)
        }
    }
}

private class PreviewUIView: UIView {
    var previewLayer: AVCaptureVideoPreviewLayer?

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer?.frame = bounds
    }
}
