@preconcurrency import AVFoundation
import SwiftUI

struct QRCodeScanner: UIViewControllerRepresentable {
  let onCode: (String) -> Void
  let onError: (String) -> Void

  func makeUIViewController(context: Context) -> ScannerViewController {
    ScannerViewController(onCode: onCode, onError: onError)
  }

  func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}
}

@MainActor
final class ScannerViewController: UIViewController,
  @preconcurrency AVCaptureMetadataOutputObjectsDelegate
{
  private let session = AVCaptureSession()
  private let onCode: (String) -> Void
  private let onError: (String) -> Void
  private var preview: AVCaptureVideoPreviewLayer?
  private var completed = false

  init(onCode: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
    self.onCode = onCode
    self.onError = onError
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    Task { @MainActor in
      let allowed = await AVCaptureDevice.requestAccess(for: .video)
      if allowed {
        configure()
      } else {
        onError("Camera access is required to scan the pairing QR")
      }
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
  }

  private func configure() {
    guard let device = AVCaptureDevice.default(for: .video) else {
      onError("No camera is available")
      return
    }
    do {
      let input = try AVCaptureDeviceInput(device: device)
      guard session.canAddInput(input) else {
        throw BridgeError(code: "CAMERA_FAILED", message: "Camera input is unavailable")
      }
      session.addInput(input)
      let output = AVCaptureMetadataOutput()
      guard session.canAddOutput(output) else {
        throw BridgeError(code: "CAMERA_FAILED", message: "QR scanner output is unavailable")
      }
      session.addOutput(output)
      output.setMetadataObjectsDelegate(self, queue: .main)
      output.metadataObjectTypes = [.qr]
      let layer = AVCaptureVideoPreviewLayer(session: session)
      layer.videoGravity = .resizeAspectFill
      layer.frame = view.bounds
      view.layer.addSublayer(layer)
      preview = layer
      DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
    } catch {
      onError(error.localizedDescription)
    }
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !completed,
      let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
      let value = object.stringValue
    else { return }
    completed = true
    session.stopRunning()
    onCode(value)
  }
}
