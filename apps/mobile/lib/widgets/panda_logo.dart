import 'package:flutter/material.dart';

import '../theme/panda_tokens.dart';

/// The Panda Code app mark — the same full-bleed artwork the launcher icon is
/// generated from, bundled at assets/app-icon.png. Rounded here to match the
/// iOS/Material app-icon feel; the asset itself carries no corners of its own,
/// so this clip is the only rounding.
class PandaLogo extends StatelessWidget {
  const PandaLogo({super.key, this.size = 28, this.radiusFactor = 0.24});

  final double size;
  final double radiusFactor;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(size * radiusFactor),
      child: Image.asset(
        'assets/app-icon.png',
        width: size,
        height: size,
        fit: BoxFit.cover,
        filterQuality: FilterQuality.medium,
      ),
    );
  }
}

/// Logo + "Panda Code" wordmark lockup, for app bars and headers. An optional
/// [subtitleTrailing] (e.g. a connection pill) sits just right of the subtitle.
class PandaWordmark extends StatelessWidget {
  const PandaWordmark(
      {super.key, this.logoSize = 26, this.subtitle, this.subtitleTrailing});

  final double logoSize;
  final String? subtitle;
  final Widget? subtitleTrailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PandaLogo(size: logoSize),
        SizedBox(width: 10),
        Flexible(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Panda Code',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
              if (subtitle != null || subtitleTrailing != null)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (subtitle != null)
                      Flexible(
                        child: Text(
                          subtitle!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: context.tokens.subtle,
                            fontSize: 11,
                          ),
                        ),
                      ),
                    if (subtitleTrailing != null) ...[
                      if (subtitle != null) const SizedBox(width: 8),
                      subtitleTrailing!,
                    ],
                  ],
                ),
            ],
          ),
        ),
      ],
    );
  }
}
