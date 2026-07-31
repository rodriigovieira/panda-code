String pairingErrorMessage(Object error) {
  final raw = error.toString();
  if (raw.contains('PAIRING_ALREADY_USED')) {
    return 'That pairing code was already used. Refresh the pairing code on your Mac and scan the new QR.';
  }
  if (raw.contains('PAIRING_EXPIRED')) {
    return 'That pairing code expired. Refresh the pairing code on your Mac and scan the new QR.';
  }
  if (raw.contains('PAIRING_NOT_FOUND')) {
    return 'That pairing code was not found. Refresh the pairing code on your Mac and scan the new QR.';
  }
  return 'Pairing failed. Check that your Mac is online and try again.';
}
