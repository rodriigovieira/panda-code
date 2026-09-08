import 'package:flutter/foundation.dart';

/// The workspace backlog, phone side. Mirrors `shared/backlog.ts` on the
/// desktop — five columns, three fields, one board per project folder.
///
/// The board is a file on the Mac that agents write to from their own
/// processes, so nothing here is a local source of truth: every mutation is a
/// command round-trip that answers with the whole board, and this holds
/// whatever came back last.
///
/// Declaration order is board order, left to right, as on the desktop:
/// `pending` sits before `backlog` because it is upstream of it — the triage
/// step, not a stage of the work — while `review` sits before `done` because it
/// is one.
///
/// `review` is the column this screen exists for. Agents cannot move a card to
/// `done` themselves (the desktop rejects the write unless the card carries
/// evidence); they hand it to Review with their verification notes and whatever
/// they captured, and the user closes it. The user is usually not at the desk
/// when that happens, which makes the phone the place the sign-off actually
/// gets done — nothing here is gated, deliberately.
enum BacklogColumn {
  pending('pending', 'Pending', 'Pending'),
  backlog('backlog', 'Backlog', 'Backlog'),
  inProgress('in_progress', 'In progress', 'Doing'),
  review('review', 'Review', 'Review'),
  done('done', 'Done', 'Done');

  const BacklogColumn(this.wire, this.label, this.shortLabel);

  /// The token the desktop stores and the relay payload carries.
  final String wire;
  final String label;

  /// The name for controls that put every column on one row — the card
  /// screen's segmented picker, which now has four segments to fit rather than
  /// three. Only `in_progress` actually differs; the rest are already short
  /// enough, and a control that renamed half its options to save space would
  /// cost more in recognition than it saved in pixels.
  final String shortLabel;

  static BacklogColumn fromWire(Object? value) {
    final text = value is String ? value : '';
    for (final column in BacklogColumn.values) {
      if (column.wire == text) return column;
    }
    // An unknown column means a newer desktop with a column this build has no
    // UI for. Showing the card in Backlog beats dropping it on the floor.
    return BacklogColumn.backlog;
  }
}

/// Columns that vanish when they hold nothing — see `COLUMNS_HIDDEN_WHEN_EMPTY`
/// on the desktop.
///
/// `pending` is an inbox for cards filed by automation (today, findings from the
/// post-push AI review) that nobody has triaged yet. An empty Backlog is
/// information; an empty Pending is a tab of dead pixels on every board with no
/// robot writing to it — which, on a phone, costs a quarter of the tab bar.
const Set<BacklogColumn> columnsHiddenWhenEmpty = {BacklogColumn.pending};

/// Whether a column earns a tab, given how many cards it would show. Takes the
/// *visible* count, so a Pending holding nothing but parked cards is empty to a
/// reader who has not asked to see held cards.
bool isColumnVisible(BacklogColumn column, int visibleCount) =>
    visibleCount > 0 || !columnsHiddenWhenEmpty.contains(column);

enum BacklogAttachmentKind {
  image,
  video;

  static BacklogAttachmentKind fromWire(Object? value) => value == 'video'
      ? BacklogAttachmentKind.video
      : BacklogAttachmentKind.image;
}

/// A screenshot or recording pinned to a card — usually an agent's proof that
/// a piece of work actually happened.
///
/// The bytes never ride this payload: `path` on the desktop side is a file on
/// the Mac, not something the relay carries, so the phone only ever sees this
/// metadata unless it has separately fetched and cached the image itself. See
/// [BacklogItem.attachments].
@immutable
class BacklogAttachment {
  final String id;
  final BacklogAttachmentKind kind;
  final String name;
  final String mimeType;
  final int size;
  final String? caption;

  /// Where the file lives on the Mac that owns the board — inside the
  /// backlog's own attachments directory (see `attachBacklogFile` on the
  /// desktop). The phone never resolves it locally; it is the argument the
  /// relay's `media` command takes to fetch the bytes on demand, exactly like
  /// a browser capture's path in a transcript.
  final String path;

  const BacklogAttachment({
    required this.id,
    required this.kind,
    required this.name,
    this.mimeType = '',
    this.size = 0,
    this.caption,
    this.path = '',
  });

  static BacklogAttachment? fromDecrypted(Map<String, dynamic> m) {
    final id = m['id'] as String?;
    if (id == null || id.isEmpty) return null;
    return BacklogAttachment(
      id: id,
      kind: BacklogAttachmentKind.fromWire(m['kind']),
      name: (m['name'] as String?) ?? 'attachment',
      mimeType: (m['mimeType'] as String?) ?? '',
      size: switch (m['size']) {
        final num n when n >= 0 => n.toInt(),
        _ => 0,
      },
      caption: m['caption'] as String?,
      path: (m['path'] as String?) ?? '',
    );
  }
}

@immutable
class VerificationScenario {
  final String id;
  final String title;
  final String setup;
  final String actions;
  final String expectedOutcome;
  final String actualOutcome;
  final String outcome;
  final String verificationType;
  final List<String> evidenceAttachmentIds;
  final String coverageLimits;

  const VerificationScenario(
      {required this.id,
      required this.title,
      this.setup = '',
      this.actions = '',
      this.expectedOutcome = '',
      this.actualOutcome = '',
      this.outcome = 'not_run',
      this.verificationType = 'other',
      this.evidenceAttachmentIds = const [],
      this.coverageLimits = ''});

  static VerificationScenario? fromDecrypted(Map<String, dynamic> m) {
    final id = m['id'] as String?;
    final title = m['title'] as String?;
    if (id == null || id.isEmpty || title == null || title.isEmpty) return null;
    return VerificationScenario(
      id: id,
      title: title,
      setup: (m['setup'] as String?) ?? '',
      actions: (m['actions'] as String?) ?? '',
      expectedOutcome: (m['expectedOutcome'] as String?) ?? '',
      actualOutcome: (m['actualOutcome'] as String?) ?? '',
      outcome: (m['outcome'] as String?) ?? 'not_run',
      verificationType: (m['verificationType'] as String?) ?? 'other',
      evidenceAttachmentIds: (m['evidenceAttachmentIds'] is List)
          ? (m['evidenceAttachmentIds'] as List).whereType<String>().toList()
          : const [],
      coverageLimits: (m['coverageLimits'] as String?) ?? '',
    );
  }
}

@immutable
class BacklogEpic {
  final String id;
  final int number;
  final String title;
  final String summary;
  final String scope;
  final String acceptanceCriteria;
  final String acceptanceScenario;

  const BacklogEpic(
      {required this.id,
      this.number = 0,
      required this.title,
      this.summary = '',
      this.scope = '',
      this.acceptanceCriteria = '',
      this.acceptanceScenario = ''});
  String get ref => number > 0 ? 'E$number' : '';

  static BacklogEpic? fromDecrypted(Map<String, dynamic> m) {
    final id = m['id'] as String?;
    final title = m['title'] as String?;
    if (id == null || id.isEmpty || title == null || title.isEmpty) return null;
    return BacklogEpic(
        id: id,
        number: m['number'] is num ? (m['number'] as num).toInt() : 0,
        title: title,
        summary: (m['summary'] as String?) ?? '',
        scope: (m['scope'] as String?) ?? '',
        acceptanceCriteria: (m['acceptanceCriteria'] as String?) ?? '',
        acceptanceScenario: (m['acceptanceScenario'] as String?) ?? '');
  }
}

@immutable
class BacklogItem {
  final String id;

  /// The card's number on its board — `#12`, counting from 1, assigned by the
  /// desktop in the order cards were filed and never reused. It is how the card
  /// is named out loud, in the desktop composer, and to an agent; the uuid stays
  /// the identity every command round-trip carries.
  ///
  /// 0 on a board written by a desktop older than the field, in which case the
  /// UI simply omits it.
  final int number;
  final String title;

  /// One-line TL;DR, written by whoever last wrote the description. Empty when
  /// nobody wrote one, in which case the UI simply omits it. The desktop keeps
  /// it to one line and a few hundred characters, so it is safe to show
  /// wherever there is room for a subtitle.
  final String summary;

  /// The body, in Markdown — agents are asked to write headings and lists here.
  final String description;
  final String metadata;
  final BacklogColumn column;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  /// True when an agent filed this card rather than the user.
  final bool byAgent;

  /// The section that filed it, when an agent did.
  final String? section;

  /// Parked: kept, but not up for work now. Not a column — the card holds the
  /// one it was parked from and returns to it — so the board hides it from
  /// every column until the user asks to see what is on hold.
  final bool onHold;

  /// What was actually checked before calling this done — distinct from
  /// `description`, which says what the card is.
  final String verificationNotes;

  /// Screenshots and recordings pinned to the card. Metadata only — see
  /// [BacklogAttachment] for why the bytes are not here.
  final List<BacklogAttachment> attachments;
  final String? epicId;
  final List<VerificationScenario> verificationScenarios;

  const BacklogItem({
    required this.id,
    this.number = 0,
    required this.title,
    this.summary = '',
    this.description = '',
    this.metadata = '',
    this.column = BacklogColumn.backlog,
    this.createdAt,
    this.updatedAt,
    this.byAgent = false,
    this.section,
    this.onHold = false,
    this.verificationNotes = '',
    this.attachments = const [],
    this.epicId,
    this.verificationScenarios = const [],
  });

  /// `#12`, or an empty string on a board that predates numbering.
  String get ref => number > 0 ? '#$number' : '';

  static DateTime? _time(Object? value) =>
      value is String ? DateTime.tryParse(value)?.toLocal() : null;

  static BacklogItem fromDecrypted(Map<String, dynamic> m) {
    return BacklogItem(
      id: (m['id'] as String?) ?? '',
      number: switch (m['number']) {
        final num n when n > 0 => n.toInt(),
        _ => 0,
      },
      title: (m['title'] as String?) ?? '',
      // Absent on a board written by a desktop older than the field, which is
      // exactly the empty-string case the UI already handles.
      summary: (m['summary'] as String?) ?? '',
      description: (m['description'] as String?) ?? '',
      metadata: (m['metadata'] as String?) ?? '',
      column: BacklogColumn.fromWire(m['column']),
      createdAt: _time(m['createdAt']),
      updatedAt: _time(m['updatedAt']),
      byAgent: m['createdBy'] == 'agent',
      section: m['createdBySection'] as String?,
      // Absent on every card that was never parked, and on any board written by
      // a desktop older than the field.
      onHold: m['onHold'] == true,
      verificationNotes: (m['verificationNotes'] as String?) ?? '',
      attachments: switch (m['attachments']) {
        final List raw => raw
            .whereType<Map>()
            .map((a) =>
                BacklogAttachment.fromDecrypted(Map<String, dynamic>.from(a)))
            .whereType<BacklogAttachment>()
            .toList(),
        _ => const [],
      },
      epicId: m['epicId'] as String?,
      verificationScenarios: switch (m['verificationScenarios']) {
        final List raw => raw
            .whereType<Map>()
            .map((s) => VerificationScenario.fromDecrypted(
                Map<String, dynamic>.from(s)))
            .whereType<VerificationScenario>()
            .toList(),
        _ => const [],
      },
    );
  }
}

@immutable
class WorkspaceBacklog {
  final String cwd;
  final List<BacklogItem> items;
  final List<BacklogEpic> epics;

  const WorkspaceBacklog(
      {this.cwd = '', this.items = const [], this.epics = const []});

  bool get isEmpty => items.isEmpty;

  /// Board order within a column is the order the desktop stored, so the phone
  /// preserves it rather than sorting by date.
  ///
  /// Parked cards are left out unless asked for: the point of putting one on
  /// hold is that it stops being in the way, and the phone is the screen with
  /// the least room to waste on work nobody is doing.
  List<BacklogItem> inColumn(BacklogColumn column,
          {bool includeOnHold = false}) =>
      items
          .where((item) =>
              item.column == column && (includeOnHold || !item.onHold))
          .toList();

  /// Every parked card, in board order, whatever column it was parked from.
  List<BacklogItem> get onHold => items.where((item) => item.onHold).toList();

  /// The columns worth drawing, in board order — everything except a Pending
  /// with nothing in it. Derived from the same counts the tabs show, so a tab
  /// can never appear with a "(0)" on it.
  List<BacklogColumn> visibleColumns({bool includeOnHold = false}) =>
      BacklogColumn.values
          .where((column) => isColumnVisible(
              column, inColumn(column, includeOnHold: includeOnHold).length))
          .toList();

  static WorkspaceBacklog fromDecrypted(Map<String, dynamic> m) {
    // Everything here is defensive rather than trusting: the payload has been
    // through a hand-editable file on the Mac, and a board that renders empty
    // beats one that throws inside the sheet that was meant to show it.
    final items = m['items'];
    return WorkspaceBacklog(
      cwd: m['cwd'] is String ? m['cwd'] as String : '',
      items: (items is List ? items : const [])
          .whereType<Map>()
          .map((raw) =>
              BacklogItem.fromDecrypted(Map<String, dynamic>.from(raw)))
          .where((item) => item.id.isNotEmpty && item.title.isNotEmpty)
          .toList(),
      epics: (m['epics'] is List ? m['epics'] as List : const [])
          .whereType<Map>()
          .map((raw) =>
              BacklogEpic.fromDecrypted(Map<String, dynamic>.from(raw)))
          .whereType<BacklogEpic>()
          .toList(),
    );
  }
}
