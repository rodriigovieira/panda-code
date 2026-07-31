import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var pendingApnsResult: FlutterResult?
  private var latestApnsToken: String?
  private var pendingNotificationTap: [String: Any]?
  private var apnsChannel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    if let userInfo = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
      pendingNotificationTap = notificationTapPayload(from: userInfo)
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    guard let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "PandaCodeApns") else {
      return
    }
    let channel = FlutterMethodChannel(
      name: "panda_code/apns",
      binaryMessenger: registrar.messenger()
    )
    apnsChannel = channel
    channel.setMethodCallHandler { [weak self] (call: FlutterMethodCall, result: @escaping FlutterResult) in
      switch call.method {
      case "register":
        self?.registerForApns(result: result)
      case "takePendingNotificationTap":
        result(self?.takePendingNotificationTap())
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func registerForApns(result: @escaping FlutterResult) {
    if let latestApnsToken {
      result(latestApnsToken)
      return
    }
    if pendingApnsResult != nil {
      result(FlutterError(
        code: "already_registering",
        message: "APNs registration is already in progress.",
        details: nil
      ))
      return
    }

    pendingApnsResult = result
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.requestAuthorization(options: [.alert, .badge, .sound]) { [weak self] granted, error in
      DispatchQueue.main.async {
        if let error {
          self?.finishApnsRegistration(error: FlutterError(
            code: "permission_error",
            message: error.localizedDescription,
            details: nil
          ))
          return
        }
        guard granted else {
          self?.finishApnsRegistration(error: FlutterError(
            code: "permission_denied",
            message: "Notifications are not authorized.",
            details: nil
          ))
          return
        }
        UIApplication.shared.registerForRemoteNotifications()
      }
    }
  }

  private func finishApnsRegistration(token: String) {
    latestApnsToken = token
    pendingApnsResult?(token)
    pendingApnsResult = nil
  }

  private func finishApnsRegistration(error: FlutterError) {
    pendingApnsResult?(error)
    pendingApnsResult = nil
  }

  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    finishApnsRegistration(token: token)
  }

  override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    finishApnsRegistration(error: FlutterError(
      code: "registration_failed",
      message: error.localizedDescription,
      details: nil
    ))
  }

  private func notificationTapPayload(from userInfo: [AnyHashable: Any]) -> [String: Any]? {
    guard let sessionId = userInfo["sessionId"] as? String, !sessionId.isEmpty else {
      return nil
    }
    var payload: [String: Any] = ["sessionId": sessionId]
    if let type = userInfo["type"] as? String {
      payload["type"] = type
    }
    return payload
  }

  private func takePendingNotificationTap() -> [String: Any]? {
    let payload = pendingNotificationTap
    pendingNotificationTap = nil
    return payload
  }

  private func handleNotificationTap(userInfo: [AnyHashable: Any]) {
    guard let payload = notificationTapPayload(from: userInfo) else { return }
    if let apnsChannel {
      apnsChannel.invokeMethod("notificationTapped", arguments: payload)
    } else {
      pendingNotificationTap = payload
    }
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    handleNotificationTap(userInfo: response.notification.request.content.userInfo)
    completionHandler()
  }
}
