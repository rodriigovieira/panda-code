import 'package:analyzer/error/error.dart' hide LintCode;
import 'package:analyzer/error/listener.dart';
import 'package:custom_lint_builder/custom_lint_builder.dart';

PluginBase createPlugin() => _PandaCodeLintsPlugin();

class _PandaCodeLintsPlugin extends PluginBase {
  @override
  List<LintRule> getLintRules(CustomLintConfigs configs) => const [
        AvoidRawDropdownWidgets(),
      ];
}

/// Forbids Flutter's stock dropdown widgets. They render an out-of-place
/// floating menu; the app uses a bottom-sheet picker instead (see
/// `showOptionPicker` / `_OptionDropdown` in `session_create_sheet.dart`).
class AvoidRawDropdownWidgets extends DartLintRule {
  const AvoidRawDropdownWidgets() : super(code: _code);

  static const _code = LintCode(
    name: 'avoid_raw_dropdown_widgets',
    problemMessage:
        'Raw Flutter dropdown widgets are forbidden in this app.',
    correctionMessage:
        'Use a bottom-sheet picker (showOptionPicker) instead of '
        'DropdownButton/DropdownButtonFormField/DropdownMenu.',
    errorSeverity: ErrorSeverity.WARNING,
  );

  @override
  void run(
    CustomLintResolver resolver,
    ErrorReporter reporter,
    CustomLintContext context,
  ) {
    context.registry.addInstanceCreationExpression((node) {
      final typeName = node.constructorName.type.name2.lexeme;

      if (typeName == 'DropdownButton' ||
          typeName == 'DropdownButtonFormField' ||
          typeName == 'DropdownMenu' ||
          typeName == 'DropdownMenuFormField') {
        reporter.atNode(node.constructorName.type, code);
      }
    });
  }
}
