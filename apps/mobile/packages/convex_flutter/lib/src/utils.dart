import 'dart:convert';

/// Recursively removes null values from maps and lists so that
/// Convex sees them as `undefined` (omitted) rather than JSON `null`.
/// This is critical because Convex's `v.optional(...)` validators
/// accept `undefined` but reject `null`.
dynamic stripNulls(dynamic value) {
  if (value == null) return null;
  if (value is Map) {
    final cleaned = <String, dynamic>{};
    for (final entry in value.entries) {
      final cleanedValue = stripNulls(entry.value);
      if (cleanedValue != null) {
        cleaned[entry.key.toString()] = cleanedValue;
      }
    }
    return cleaned;
  }
  if (value is List) {
    return value.map(stripNulls).toList();
  }
  return value;
}

/// Converts a map of dynamic arguments to JSON-encoded strings
/// suitable for the Convex Rust bridge. Null top-level values are
/// omitted so that Convex treats them as `undefined`.
Map<String, String> buildArgs(Map<String, dynamic> record) {
  return {
    for (var entry in record.entries)
      if (entry.value != null) entry.key: jsonEncode(stripNulls(entry.value)),
  };
}
