import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/dictation/dictation_service.dart';

void main() {
  group('DictationVocabulary.parse', () {
    test('reads terms, phrases, and persona', () {
      final vocabulary = DictationVocabulary.parse(jsonEncode({
        'terms': ['PandaPDV', 'e2e'],
        'phrases': ['deploy the backend'],
        'persona': {'median_prompt_words': 15},
      }));

      expect(vocabulary.terms, ['PandaPDV', 'e2e']);
      expect(vocabulary.phrases, ['deploy the backend']);
      expect(vocabulary.persona['median_prompt_words'], 15);
      expect(vocabulary.isEmpty, isFalse);
    });

    test('drops non-string and blank entries', () {
      final vocabulary = DictationVocabulary.parse(jsonEncode({
        'terms': ['PandaPDV', 42, '', '   ', null],
      }));

      expect(vocabulary.terms, ['PandaPDV']);
    });

    test('tolerates missing and wrongly-typed sections', () {
      final vocabulary = DictationVocabulary.parse(jsonEncode({
        'terms': 'not-a-list',
        'persona': 'not-a-map',
      }));

      expect(vocabulary.terms, isEmpty);
      expect(vocabulary.phrases, isEmpty);
      expect(vocabulary.persona, isEmpty);
      expect(vocabulary.isEmpty, isTrue);
    });

    test('a non-object payload yields the empty vocabulary', () {
      expect(DictationVocabulary.parse('[]').isEmpty, isTrue);
    });
  });

  group('DictationVocabulary.version', () {
    // The native side caches the trained language model under this key, so it
    // must be stable for identical phrases and differ when they change -
    // otherwise re-mining either retrains needlessly or serves a stale model.
    test('is stable for the same phrases', () {
      const a = DictationVocabulary(
          terms: [], phrases: ['alpha', 'beta'], persona: {});
      const b = DictationVocabulary(
          terms: ['ignored'], phrases: ['alpha', 'beta'], persona: {});

      expect(a.version, b.version);
    });

    test('changes when the phrases change', () {
      const a = DictationVocabulary(terms: [], phrases: ['alpha'], persona: {});
      const b = DictationVocabulary(terms: [], phrases: ['alphb'], persona: {});

      expect(a.version, isNot(b.version));
    });

    test('is order-sensitive, since ranking is part of the training data', () {
      const a = DictationVocabulary(
          terms: [], phrases: ['alpha', 'beta'], persona: {});
      const b = DictationVocabulary(
          terms: [], phrases: ['beta', 'alpha'], persona: {});

      expect(a.version, isNot(b.version));
    });

    test('an empty phrase set is named rather than hashed', () {
      expect(DictationVocabulary.empty.version, 'empty');
    });
  });

  group('DictationVocabulary.withSeed', () {
    test('keeps mined terms first, since they are ranked by real use', () {
      const mined = DictationVocabulary(
          terms: ['Convex', 'relay'], phrases: [], persona: {});

      expect(mined.withSeed(['Riverpod', 'pbxproj']).terms,
          ['Convex', 'relay', 'Riverpod', 'pbxproj']);
    });

    test('does not spend a bias slot on a term already mined', () {
      const mined =
          DictationVocabulary(terms: ['Convex'], phrases: [], persona: {});

      // Case differs because the miner keeps the surface form the user typed.
      expect(mined.withSeed(['convex', 'Melos']).terms, ['Convex', 'Melos']);
    });

    test('is the whole vocabulary on a machine with nothing mined', () {
      expect(DictationVocabulary.empty.withSeed(['Convex']).terms, ['Convex']);
    });

    test('leaves the trained language model alone', () {
      const mined =
          DictationVocabulary(terms: [], phrases: ['ship it'], persona: {});
      final seeded = mined.withSeed(['Convex']);

      // Seed terms bias recognition; they are not training data, so adding
      // them must not invalidate the cached model.
      expect(seeded.phrases, ['ship it']);
      expect(seeded.version, mined.version);
    });
  });

  group('DictationLocale', () {
    // Dictation must not follow the phone's language: decoding English speech
    // through a pt-BR model returns unrelated words, not mangled ones.
    test('defaults to English rather than the system locale', () {
      expect(DictationLocale.normalize(null), 'en-US');
      expect(DictationLocale.normalize(''), 'en-US');
    });

    test('rejects a locale with no recogniser option', () {
      expect(DictationLocale.normalize('xx-YY'), 'en-US');
    });

    test('keeps a supported choice', () {
      expect(DictationLocale.normalize('pt-BR'), 'pt-BR');
      expect(DictationLocale.label('pt-BR'), 'Português (Brasil)');
    });
  });
}
