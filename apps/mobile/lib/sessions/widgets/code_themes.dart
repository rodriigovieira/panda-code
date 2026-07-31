import 'package:flutter/material.dart';
import 'package:flutter_highlight/themes/a11y-dark.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:flutter_highlight/themes/dracula.dart';
import 'package:flutter_highlight/themes/github.dart';
import 'package:flutter_highlight/themes/monokai-sublime.dart';
import 'package:flutter_highlight/themes/nord.dart';
import 'package:flutter_highlight/themes/tomorrow-night.dart';
import 'package:flutter_highlight/themes/vs2015.dart';

/// A selectable syntax-highlighting theme for code blocks / tool output.
class CodeThemeOption {
  final String id;
  final String label;
  final Map<String, TextStyle> theme;

  const CodeThemeOption(this.id, this.label, this.theme);

  /// The editor background, derived from the theme's `root` style.
  Color get background =>
      theme['root']?.backgroundColor ?? const Color(0xFF282C34);
}

const codeThemeOptions = <CodeThemeOption>[
  CodeThemeOption('atom-one-dark', 'Atom One Dark', atomOneDarkTheme),
  CodeThemeOption('dracula', 'Dracula', draculaTheme),
  CodeThemeOption('monokai-sublime', 'Monokai', monokaiSublimeTheme),
  CodeThemeOption('nord', 'Nord', nordTheme),
  CodeThemeOption('tomorrow-night', 'Tomorrow Night', tomorrowNightTheme),
  CodeThemeOption('vs2015', 'VS 2015', vs2015Theme),
  CodeThemeOption('a11y-dark', 'A11y Dark', a11yDarkTheme),
  CodeThemeOption('github', 'GitHub (light)', githubTheme),
];

CodeThemeOption codeThemeById(String id) => codeThemeOptions.firstWhere(
      (o) => o.id == id,
      orElse: () => codeThemeOptions.first,
    );
