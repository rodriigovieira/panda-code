import 'package:flutter_test/flutter_test.dart';
import 'package:panda_code_mobile/backlog/backlog_models.dart';
import 'package:panda_code_mobile/backlog/card_mentions.dart';

void main() {
  group('BacklogColumn', () {
    test('maps the wire tokens the desktop sends', () {
      expect(BacklogColumn.fromWire('in_progress'), BacklogColumn.inProgress);
      expect(BacklogColumn.fromWire('done'), BacklogColumn.done);
    });

    test('reads the pending column the desktop added', () {
      expect(BacklogColumn.fromWire('pending'), BacklogColumn.pending);
      // Board order, left to right: triage sits upstream of Backlog.
      expect(BacklogColumn.values.first, BacklogColumn.pending);
    });

    test('parks an unknown column in Backlog rather than dropping the card',
        () {
      expect(BacklogColumn.fromWire('blocked'), BacklogColumn.backlog);
      expect(BacklogColumn.fromWire(null), BacklogColumn.backlog);
    });
  });

  group('visible columns', () {
    WorkspaceBacklog board(List<Map<String, dynamic>> items) =>
        WorkspaceBacklog.fromDecrypted({'cwd': '/repo', 'items': items});

    test('hides Pending while it is empty, and only Pending', () {
      final columns = board([
        {'id': 'a', 'title': 'Waiting', 'column': 'backlog'},
      ]).visibleColumns();

      expect(columns, [
        BacklogColumn.backlog,
        BacklogColumn.inProgress,
        BacklogColumn.review,
        BacklogColumn.done,
      ]);
    });

    test('shows Pending as soon as automation files something', () {
      final columns = board([
        {'id': 'a', 'title': 'Review finding', 'column': 'pending'},
      ]).visibleColumns();

      expect(columns.first, BacklogColumn.pending);
      expect(columns.length, 5);
    });

    test(
        'keeps Review on the board while it is empty — it is a stage, not an inbox',
        () {
      final columns = board([
        {'id': 'a', 'title': 'Waiting', 'column': 'backlog'},
      ]).visibleColumns();

      expect(columns, contains(BacklogColumn.review));
    });

    test('a Pending holding only parked cards is empty until they are shown',
        () {
      final held = board([
        {
          'id': 'a',
          'title': 'Parked finding',
          'column': 'pending',
          'onHold': true
        },
      ]);

      expect(held.visibleColumns(), isNot(contains(BacklogColumn.pending)));
      expect(held.visibleColumns(includeOnHold: true),
          contains(BacklogColumn.pending));
    });
  });

  group('WorkspaceBacklog.fromDecrypted', () {
    Map<String, dynamic> board(List<Map<String, dynamic>> items) =>
        {'cwd': '/repo', 'items': items};

    test('reads a board, keeping the desktop\'s order within a column', () {
      final parsed = WorkspaceBacklog.fromDecrypted(board([
        {'id': 'a', 'title': 'First', 'column': 'backlog'},
        {'id': 'b', 'title': 'Doing', 'column': 'in_progress'},
        {'id': 'c', 'title': 'Second', 'column': 'backlog'},
      ]));

      expect(parsed.cwd, '/repo');
      expect(parsed.inColumn(BacklogColumn.backlog).map((i) => i.title),
          ['First', 'Second']);
      expect(parsed.inColumn(BacklogColumn.inProgress).single.title, 'Doing');
      expect(parsed.inColumn(BacklogColumn.done), isEmpty);
    });

    test('keeps parked cards off the board unless they are asked for', () {
      final parsed = WorkspaceBacklog.fromDecrypted(board([
        {'id': 'a', 'title': 'Live', 'column': 'backlog'},
        {'id': 'b', 'title': 'Parked', 'column': 'backlog', 'onHold': true},
      ]));

      expect(
          parsed.inColumn(BacklogColumn.backlog).map((i) => i.title), ['Live']);
      expect(
        parsed
            .inColumn(BacklogColumn.backlog, includeOnHold: true)
            .map((i) => i.title),
        ['Live', 'Parked'],
      );
      // Parked, not moved: it comes back to the column it was set aside from.
      expect(parsed.onHold.single.column, BacklogColumn.backlog);
      expect(parsed.items.first.onHold, isFalse);
    });

    test('drops rows with no id or no title', () {
      final parsed = WorkspaceBacklog.fromDecrypted(board([
        {'id': '', 'title': 'No id'},
        {'id': 'b', 'title': ''},
        {'id': 'c', 'title': 'Keep'},
      ]));
      expect(parsed.items.map((i) => i.title), ['Keep']);
    });

    test('carries who filed the card', () {
      final parsed = WorkspaceBacklog.fromDecrypted(board([
        {
          'id': 'a',
          'title': 'Agent card',
          'createdBy': 'agent',
          'createdBySection': 'Relay work',
        },
        {'id': 'b', 'title': 'My card'},
      ]));

      expect(parsed.items.first.byAgent, isTrue);
      expect(parsed.items.first.section, 'Relay work');
      expect(parsed.items.last.byAgent, isFalse);
    });

    test('reads the TL;DR, and stays empty for a desktop that has none', () {
      final parsed = WorkspaceBacklog.fromDecrypted(board([
        {'id': 'a', 'title': 'A', 'summary': 'Blocked on the relay deploy.'},
        {'id': 'b', 'title': 'B'},
      ]));
      expect(parsed.items.first.summary, 'Blocked on the relay deploy.');
      expect(parsed.items.last.summary, '');
    });

    test('reads verification notes and attachment metadata', () {
      final parsed = WorkspaceBacklog.fromDecrypted(board([
        {
          'id': 'a',
          'title': 'A',
          'verificationNotes': 'Checked the empty state in the browser.',
          'attachments': [
            {
              'id': 'att-1',
              'kind': 'image',
              'name': 'empty-state.png',
              'mimeType': 'image/png',
              'size': 2048,
              'caption': 'Empty state',
            },
            {'id': 'att-2', 'kind': 'video', 'name': 'flow.mp4'},
          ],
        },
      ]));
      final item = parsed.items.single;
      expect(item.verificationNotes, 'Checked the empty state in the browser.');
      expect(item.attachments, hasLength(2));
      expect(item.attachments.first.kind, BacklogAttachmentKind.image);
      expect(item.attachments.first.caption, 'Empty state');
      expect(item.attachments.last.kind, BacklogAttachmentKind.video);
    });

    test('drops an attachment with no id rather than the whole card', () {
      final parsed = WorkspaceBacklog.fromDecrypted(board([
        {
          'id': 'a',
          'title': 'A',
          'attachments': [
            {'kind': 'image', 'name': 'no-id.png'},
            {'id': 'att-1', 'kind': 'image', 'name': 'keep.png'},
          ],
        },
      ]));
      expect(parsed.items.single.attachments.map((a) => a.name), ['keep.png']);
    });

    test('defaults to empty notes and no attachments on an older board', () {
      final parsed = WorkspaceBacklog.fromDecrypted(board([
        {'id': 'a', 'title': 'A'},
      ]));
      expect(parsed.items.single.verificationNotes, '');
      expect(parsed.items.single.attachments, isEmpty);
    });

    test('survives a board with nothing on it', () {
      expect(WorkspaceBacklog.fromDecrypted({}).isEmpty, isTrue);
      expect(WorkspaceBacklog.fromDecrypted({'items': 'nonsense'}).isEmpty,
          isTrue);
    });

    test('parses timestamps and leaves unparseable ones null', () {
      final parsed = WorkspaceBacklog.fromDecrypted(board([
        {
          'id': 'a',
          'title': 'A',
          'createdAt': '2026-08-03T10:00:00.000Z',
          'updatedAt': 'nope'
        },
      ]));
      expect(parsed.items.single.createdAt, isNotNull);
      expect(parsed.items.single.updatedAt, isNull);
    });
  });

  group('card numbers', () {
    test('reads the number the desktop assigned, and shows it as #12', () {
      final item =
          BacklogItem.fromDecrypted({'id': 'a', 'title': 'T', 'number': 12});
      expect(item.number, 12);
      expect(item.ref, '#12');
    });

    test('omits the reference on a board written before numbering', () {
      final item = BacklogItem.fromDecrypted({'id': 'a', 'title': 'T'});
      expect(item.number, 0);
      expect(item.ref, '');
    });
  });

  group('Epics and verification scenarios', () {
    test('reads optional Epic membership and structured attempt history', () {
      final parsed = WorkspaceBacklog.fromDecrypted({
        'cwd': '/repo',
        'epics': [
          {
            'id': 'e1',
            'number': 4,
            'title': 'Trusted review',
            'summary': 'One outcome'
          }
        ],
        'items': [
          {
            'id': 'a',
            'title': 'Flow',
            'epicId': 'e1',
            'verificationScenarios': [
              {
                'id': 's1',
                'title': 'Save persists',
                'outcome': 'passed',
                'verificationType': 'installed_app',
                'actualOutcome': 'Persisted after reopen'
              }
            ]
          }
        ],
      });
      expect(parsed.epics.single.ref, 'E4');
      expect(parsed.items.single.epicId, 'e1');
      expect(
          parsed.items.single.verificationScenarios.single.outcome, 'passed');
    });

    test('keeps legacy boards valid with no Epic or scenario fields', () {
      final parsed = WorkspaceBacklog.fromDecrypted({
        'items': [
          {'id': 'a', 'title': 'Legacy'}
        ]
      });
      expect(parsed.epics, isEmpty);
      expect(parsed.items.single.verificationScenarios, isEmpty);
    });
  });

  group('card mentions', () {
    final cards = [
      const BacklogItem(
          id: 'a', number: 12, title: 'Collapse the window readers'),
      const BacklogItem(
          id: 'b',
          number: 3,
          title: 'Ship the relay fix',
          summary: 'Blocked on deploy'),
    ];

    test('opens on a # at the end of the text, and only there', () {
      expect(cardMentionQuery('do #'), '');
      expect(cardMentionQuery('do #win'), 'win');
      expect(cardMentionQuery('#12'), '12');
      expect(cardMentionQuery('do #12 next'), isNull);
      expect(cardMentionQuery('a#12'), isNull);
      expect(cardMentionQuery('#ff0000 #'), '');
    });

    test('filters by number, title and summary', () {
      expect(filterCardMentions('', cards).length, 2);
      expect(filterCardMentions('12', cards).single.title,
          'Collapse the window readers');
      expect(filterCardMentions('relay', cards).single.number, 3);
      expect(filterCardMentions('deploy', cards).single.number, 3);
      expect(filterCardMentions('nothing', cards), isEmpty);
      expect(filterCardMentions(null, cards), isEmpty);
    });

    test('replaces the query with the number, keeping the sentence', () {
      expect(applyCardMention('do #win', cards.first), 'do #12 ');
      expect(applyCardMention('#', cards.first), '#12 ');
      expect(
          applyCardMention('no mention here', cards.first), 'no mention here');
    });
  });

  group('card references', () {
    test('matches a bare #12, not a colour or a big number or word#3', () {
      expect(
          cardRefPattern.allMatches('see #12 please').map((m) => m[1]), ['12']);
      expect(cardRefPattern.hasMatch('#ff0000'), isFalse);
      expect(cardRefPattern.hasMatch('#123456'), isFalse);
      expect(cardRefPattern.hasMatch('word#3'), isFalse);
      expect(cardRefPattern.hasMatch('##12'), isFalse);
    });

    test('reads the number back out of the synthetic href', () {
      expect(cardNumberFromCardRefHref('panda://backlog/12'), 12);
      expect(cardNumberFromCardRefHref('https://example.com'), isNull);
    });
  });
}
