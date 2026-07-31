import 'package:flutter/material.dart';

import '../../theme/panda_tokens.dart';
import '../models.dart';

/// Shared cost rendering for the phone: the session info sheet and the global
/// usage screen both show the same breakdown of a [UsageCostReport]. The report
/// is always computed desktop-side (only the desktop observes every turn), so
/// nothing here does arithmetic on rates.

String formatCostTokens(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(2)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k';
  return '$n';
}

/// The headline: one big dollar figure with a token subtitle.
class CostHeadline extends StatelessWidget {
  const CostHeadline({
    super.key,
    required this.label,
    required this.report,
    this.subtitle,
    this.trailing,
  });

  final String label;
  final UsageCostReport report;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accent = theme.colorScheme.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: accent.withValues(alpha: 0.32)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: TextStyle(
                    color: context.tokens.muted,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                SizedBox(height: 4),
                Text(
                  formatUsd(report.cost.totalUsd),
                  style: TextStyle(
                    color: accent,
                    fontSize: 28,
                    fontWeight: FontWeight.w800,
                    height: 1.1,
                  ),
                ),
                SizedBox(height: 3),
                Text(
                  subtitle ?? '${formatCostTokens(report.tokens.total)} tokens',
                  style: TextStyle(color: context.tokens.subtle, fontSize: 12),
                ),
              ],
            ),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

/// Input / output / cache write / cache read, each with its token count and cost.
class CostClassRows extends StatelessWidget {
  const CostClassRows({super.key, required this.report});

  final UsageCostReport report;

  @override
  Widget build(BuildContext context) {
    final tokens = report.tokens;
    final cost = report.cost;
    final rows = <({String label, int tokens, double usd})>[
      (label: 'Input', tokens: tokens.inputTokens, usd: cost.inputUsd),
      (label: 'Output', tokens: tokens.outputTokens, usd: cost.outputUsd),
      (
        label: 'Cache write',
        tokens: tokens.cacheCreationInputTokens,
        usd: cost.cacheWriteUsd
      ),
      (
        label: 'Cache read',
        tokens: tokens.cacheReadInputTokens,
        usd: cost.cacheReadUsd
      ),
    ];
    return Container(
      decoration: BoxDecoration(
        color: context.tokens.panelHover,
        borderRadius: BorderRadius.circular(10),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      child: Column(
        children: [
          for (final row in rows)
            _CostLine(label: row.label, tokens: row.tokens, usd: row.usd),
          Divider(height: 1, color: context.tokens.lineSoft),
          _CostLine(
            label: 'Total',
            tokens: tokens.total,
            usd: cost.totalUsd,
            emphasize: true,
          ),
        ],
      ),
    );
  }
}

class _CostLine extends StatelessWidget {
  const _CostLine({
    required this.label,
    required this.tokens,
    required this.usd,
    this.emphasize = false,
  });

  final String label;
  final int tokens;
  final double usd;
  final bool emphasize;

  @override
  Widget build(BuildContext context) {
    final weight = emphasize ? FontWeight.w700 : FontWeight.w500;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                color: emphasize ? context.tokens.text : context.tokens.muted,
                fontSize: 13,
                fontWeight: weight,
              ),
            ),
          ),
          Text(
            formatCostTokens(tokens),
            style: TextStyle(
              color: context.tokens.subtle,
              fontSize: 12.5,
              fontWeight: weight,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          SizedBox(width: 14),
          SizedBox(
            width: 76,
            child: Text(
              formatUsd(usd),
              textAlign: TextAlign.right,
              style: TextStyle(
                color: context.tokens.run.text,
                fontSize: emphasize ? 14 : 13,
                fontWeight: FontWeight.w700,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Per (provider, model) spend — the part that makes a handed-off session legible.
class CostModelRows extends StatelessWidget {
  const CostModelRows({super.key, required this.report});

  final UsageCostReport report;

  @override
  Widget build(BuildContext context) {
    if (report.groups.isEmpty) return const SizedBox.shrink();
    return Column(
      children: [
        for (final group in report.groups)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: context.tokens.panelHover,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      _RuntimeTag(runtime: group.runtime),
                      SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          group.modelLabel,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: context.tokens.text,
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Text(
                        formatUsd(group.cost.totalUsd),
                        style: TextStyle(
                          color: context.tokens.run.text,
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                  SizedBox(height: 4),
                  Text(
                    '${formatCostTokens(group.tokens.total)} tokens'
                    '${group.rateSummary != null ? ' · ${group.rateSummary}' : ' · no known rate'}',
                    style:
                        TextStyle(color: context.tokens.subtle, fontSize: 11),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _RuntimeTag extends StatelessWidget {
  const _RuntimeTag({required this.runtime});

  final AgentRuntime runtime;

  @override
  Widget build(BuildContext context) {
    final color = runtime == AgentRuntime.codex
        ? context.tokens.agent.text
        : context.tokens.info.text;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        agentRuntimeLabel(runtime).toUpperCase(),
        style: TextStyle(
          color: color,
          fontSize: 9.5,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.6,
        ),
      ),
    );
  }
}

/// Surfaces models the desktop had no rate for, so a low total is never read as
/// the whole story.
class CostUnpricedNote extends StatelessWidget {
  const CostUnpricedNote({super.key, required this.report});

  final UsageCostReport report;

  @override
  Widget build(BuildContext context) {
    if (report.unpricedModels.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Text(
        'No rate on file for ${report.unpricedModels.join(', ')}, so the total '
        'leaves those tokens out.',
        style: TextStyle(color: context.tokens.accent.text, fontSize: 11.5),
      ),
    );
  }
}
