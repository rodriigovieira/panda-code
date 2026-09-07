import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/pairing/pairing_store.dart';
import 'package:panda_code_mobile/security/app_lock.dart';
import 'package:panda_code_mobile/security/app_lock_gate.dart';
import 'package:panda_code_mobile/sessions/settings_store.dart';
import 'package:panda_code_mobile/state/providers.dart';
class Paired extends PairingController {
 @override Future<PairingCredentials?> build() async => const PairingCredentials(url:'https://your-deployment.convex.cloud',deviceId:'device',mobileId:'phone',mobileToken:'fixture',keyBase64:'fixture');
}
class Settings extends SettingsController {
 @override Future<AppSettings> build() async => const AppSettings(appLockEnabled:true);
}
class Locked extends AppLockController {
 @override AppLockState build() => const AppLockState(locked:true,authInProgress:true);
}
void main() {
 testWidgets('locked routes cannot render or receive keyboard focus', (tester) async {
  final focus = FocusNode(); addTearDown(focus.dispose);
  await tester.pumpWidget(ProviderScope(overrides:[pairingProvider.overrideWith(Paired.new),settingsProvider.overrideWith(Settings.new),appLockProvider.overrideWith(Locked.new)],child:MaterialApp(home:AppLockGate(child:Scaffold(body:TextField(focusNode:focus,decoration:const InputDecoration(labelText:'Private prompt')))))));
  await tester.pump(); await tester.pump();
  expect(find.text('Panda Code is locked'),findsOneWidget);
  expect(find.text('Private prompt'),findsNothing);
  focus.requestFocus(); await tester.pump();
  expect(focus.hasFocus,isFalse);
 });
}
