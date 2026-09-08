import Flutter
import CryptoKit
import LocalAuthentication
import Security
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

    if let dictationRegistrar = engineBridge.pluginRegistry.registrar(
      forPlugin: "PandaCodeDictation") {
      DictationPlugin.register(with: dictationRegistrar)
    }

    if let identityRegistrar = engineBridge.pluginRegistry.registrar(
      forPlugin: "PandaCodeCommandIdentity") {
      let identityChannel = FlutterMethodChannel(
        name: "panda_code/command_identity",
        binaryMessenger: identityRegistrar.messenger()
      )
      identityChannel.setMethodCallHandler { call, result in
        CommandIdentityKey.handle(call: call, result: result)
      }
    }

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

private enum CommandIdentityKey {
  private static let tag = Data("com.pandacode.mobile.command-identity.v3".utf8)

  static func handle(call: FlutterMethodCall, result: @escaping FlutterResult) {
    do {
      switch call.method {
      case "loadOrCreate":
        let pair = try loadOrCreate()
        let publicData = try externalRepresentation(pair.privateKey)
        result([
          "keyId": SHA256.hash(data: publicData).map { String(format: "%02x", $0) }.joined(),
          "publicKey": publicData.base64EncodedString(),
          "protection": pair.protection,
        ])
      case "sign":
        guard
          let arguments = call.arguments as? [String: Any],
          let messageBase64 = arguments["message"] as? String,
          let message = Data(base64Encoded: messageBase64)
        else { throw IdentityError.invalidArguments }
        let pair = try loadExisting()
        let publicData = try externalRepresentation(pair.privateKey)
        let actualKeyId = SHA256.hash(data: publicData).map { String(format: "%02x", $0) }.joined()
        guard arguments["keyId"] as? String == actualKeyId else {
          throw IdentityError.keyChanged
        }
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(
          pair.privateKey,
          .ecdsaSignatureMessageX962SHA256,
          message as CFData,
          &error
        ) as Data? else {
          if let error { throw error.takeRetainedValue() }
          throw IdentityError.signingFailed
        }
        result(signature.base64EncodedString())
      default:
        result(FlutterMethodNotImplemented)
      }
    } catch {
      result(FlutterError(
        code: "command_identity_unavailable",
        message: error.localizedDescription,
        details: nil
      ))
    }
  }

  private static func loadOrCreate() throws -> (privateKey: SecKey, protection: String) {
    if let existing = try? loadExisting() { return existing }
    let context = LAContext()
    var authError: NSError?
    let biometryBound = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError)
    let flags: SecAccessControlCreateFlags = biometryBound
      ? [.privateKeyUsage, .biometryCurrentSet]
      : [.privateKeyUsage, .userPresence]
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      flags,
      &accessError
    ) else { throw accessError!.takeRetainedValue() }

    do {
      let protection = biometryBound ? "secure-enclave-biometry-current-set" : "secure-enclave-user-presence"
      return (try create(access: access, secureEnclave: true, protection: protection), protection)
    } catch {
      let status = (error as NSError).code
      guard mayUseSoftwareFallback(osStatus: status) else {
        // Entitlement, access-control, or storage failures must not silently
        // downgrade a device that should have hardware-backed signing.
        throw error
      }
      // Older devices and simulators have no Secure Enclave. The fallback is
      // still non-synchronizable, ThisDeviceOnly, and gated by user presence.
      let protection = biometryBound ? "keychain-biometry-current-set" : "keychain-user-presence"
      return (try create(access: access, secureEnclave: false, protection: protection), protection)
    }
  }

  /// Only definitive platform-unavailable statuses permit a software key.
  /// In particular, errSecParam is treated as our configuration bug.
  private static func mayUseSoftwareFallback(osStatus: Int) -> Bool {
    osStatus == Int(errSecUnimplemented) || osStatus == Int(errSecNotAvailable)
  }

  private static func create(access: SecAccessControl, secureEnclave: Bool, protection: String) throws -> SecKey {
    var privateAttributes: [String: Any] = [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag,
      kSecAttrAccessControl as String: access,
      kSecAttrSynchronizable as String: false,
      kSecAttrLabel as String: protection,
    ]
    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: privateAttributes,
    ]
    if secureEnclave {
      attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    }
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw error!.takeRetainedValue()
    }
    return key
  }

  private static func loadExisting() throws -> (privateKey: SecKey, protection: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrSynchronizable as String: false,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let key = item as! SecKey? else {
      throw IdentityError.keyMissing
    }
    let attrs = SecKeyCopyAttributes(key) as? [String: Any]
    let secure = attrs?[kSecAttrTokenID as String] as? String == (kSecAttrTokenIDSecureEnclave as String)
    let protection = attrs?[kSecAttrLabel as String] as? String ??
      (secure ? "secure-enclave-biometry-current-set" : "keychain-biometry-current-set")
    return (key, protection)
  }

  private static func externalRepresentation(_ privateKey: SecKey) throws -> Data {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else { throw IdentityError.keyMissing }
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw error!.takeRetainedValue()
    }
    return data
  }

  private enum IdentityError: LocalizedError {
    case invalidArguments, keyMissing, keyChanged, signingFailed
    var errorDescription: String? {
      switch self {
      case .invalidArguments: return "Invalid command signing request."
      case .keyMissing: return "The command identity is missing or was invalidated. Pair this phone again."
      case .keyChanged: return "The command identity changed. Pair this phone again."
      case .signingFailed: return "Face ID did not authorize the command."
      }
    }
  }
}
