import 'package:flutter/foundation.dart';

/// A workspace's git status, phone side. Mirrors `WorkspaceGitStatus` in
/// `apps/desktop/src/shared/ipc.ts` — the same read the desktop's own git
/// panel uses, round-tripped read-only over the relay (see
/// `relay_api.dart`'s `gitStatus()`).
@immutable
class WorkspaceGitChange {
  final String code;
  final String path;

  const WorkspaceGitChange({required this.code, required this.path});

  static WorkspaceGitChange fromDecrypted(Map<String, dynamic> m) =>
      WorkspaceGitChange(
        code: (m['code'] as String?) ?? '',
        path: (m['path'] as String?) ?? '',
      );
}

@immutable
class WorkspaceGitWorktree {
  final String path;
  final String? branch;
  final String? head;

  const WorkspaceGitWorktree({required this.path, this.branch, this.head});

  static WorkspaceGitWorktree fromDecrypted(Map<String, dynamic> m) =>
      WorkspaceGitWorktree(
        path: (m['path'] as String?) ?? '',
        branch: m['branch'] as String?,
        head: m['head'] as String?,
      );
}

@immutable
class WorkspaceGitBranch {
  final String name;
  final bool current;

  const WorkspaceGitBranch({required this.name, this.current = false});

  static WorkspaceGitBranch fromDecrypted(Map<String, dynamic> m) =>
      WorkspaceGitBranch(
        name: (m['name'] as String?) ?? '',
        current: m['current'] == true,
      );
}

@immutable
class WorkspaceGitRemote {
  final String name;
  final String? url;
  final String? ref;
  final int? ahead;
  final int? behind;
  final bool upstream;

  const WorkspaceGitRemote({
    required this.name,
    this.url,
    this.ref,
    this.ahead,
    this.behind,
    this.upstream = false,
  });

  static WorkspaceGitRemote fromDecrypted(Map<String, dynamic> m) =>
      WorkspaceGitRemote(
        name: (m['name'] as String?) ?? '',
        url: m['url'] as String?,
        ref: m['ref'] as String?,
        ahead: m['ahead'] is num ? (m['ahead'] as num).toInt() : null,
        behind: m['behind'] is num ? (m['behind'] as num).toInt() : null,
        upstream: m['upstream'] == true,
      );
}

/// One commit in the workspace's history. Mirrors `WorkspaceGitCommit` in
/// `apps/desktop/src/shared/ipc.ts`.
@immutable
class WorkspaceGitCommit {
  final String hash;
  final String shortHash;
  final String subject;
  final String author;
  final DateTime? date;
  final List<String> refs;

  const WorkspaceGitCommit({
    required this.hash,
    required this.shortHash,
    required this.subject,
    required this.author,
    this.date,
    this.refs = const [],
  });

  static WorkspaceGitCommit fromDecrypted(Map<String, dynamic> m) {
    final date = m['date'] as String?;
    return WorkspaceGitCommit(
      hash: (m['hash'] as String?) ?? '',
      shortHash: (m['shortHash'] as String?) ?? '',
      subject: (m['subject'] as String?) ?? '',
      author: (m['author'] as String?) ?? '',
      date: date != null ? DateTime.tryParse(date)?.toLocal() : null,
      refs: (m['refs'] is List ? (m['refs'] as List) : const [])
          .whereType<String>()
          .toList(),
    );
  }
}

/// One page of `git log`, newest first. `hasMore` is the desktop telling us
/// there is at least one commit past this page — it reads one extra rather
/// than counting the whole repo.
@immutable
class WorkspaceGitLog {
  final bool isRepo;
  final String? branch;
  final List<WorkspaceGitCommit> commits;
  final int skip;
  final bool hasMore;
  final String? error;

  const WorkspaceGitLog({
    this.isRepo = false,
    this.branch,
    this.commits = const [],
    this.skip = 0,
    this.hasMore = false,
    this.error,
  });

  static WorkspaceGitLog fromDecrypted(Map<String, dynamic> m) =>
      WorkspaceGitLog(
        isRepo: m['isRepo'] == true,
        branch: m['branch'] as String?,
        commits: (m['commits'] is List ? (m['commits'] as List) : const [])
            .whereType<Map>()
            .map((e) =>
                WorkspaceGitCommit.fromDecrypted(Map<String, dynamic>.from(e)))
            .toList(),
        skip: m['skip'] is num ? (m['skip'] as num).toInt() : 0,
        hasMore: m['hasMore'] == true,
        error: m['error'] as String?,
      );
}

@immutable
class WorkspaceWorkflowRun {
  final int databaseId;
  final String name;
  final String displayTitle;
  final String status;
  final String? conclusion;
  final String headBranch;
  final String event;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final String url;

  const WorkspaceWorkflowRun({
    required this.databaseId,
    required this.name,
    required this.displayTitle,
    required this.status,
    this.conclusion,
    required this.headBranch,
    required this.event,
    this.createdAt,
    this.updatedAt,
    required this.url,
  });

  static WorkspaceWorkflowRun fromDecrypted(Map<String, dynamic> m) =>
      WorkspaceWorkflowRun(
        databaseId:
            m['databaseId'] is num ? (m['databaseId'] as num).toInt() : 0,
        name: (m['name'] as String?) ?? 'Workflow',
        displayTitle: (m['displayTitle'] as String?) ?? '',
        status: (m['status'] as String?) ?? 'unknown',
        conclusion: m['conclusion'] as String?,
        headBranch: (m['headBranch'] as String?) ?? '',
        event: (m['event'] as String?) ?? '',
        createdAt:
            DateTime.tryParse((m['createdAt'] as String?) ?? '')?.toLocal(),
        updatedAt:
            DateTime.tryParse((m['updatedAt'] as String?) ?? '')?.toLocal(),
        url: (m['url'] as String?) ?? '',
      );
}

@immutable
class WorkspaceWorkflowRuns {
  final List<WorkspaceWorkflowRun> runs;
  final int limit;
  final bool hasMore;
  final String? error;

  const WorkspaceWorkflowRuns({
    this.runs = const [],
    this.limit = 10,
    this.hasMore = false,
    this.error,
  });

  static WorkspaceWorkflowRuns fromDecrypted(Map<String, dynamic> m) =>
      WorkspaceWorkflowRuns(
        runs: (m['runs'] is List ? (m['runs'] as List) : const [])
            .whereType<Map>()
            .map((e) => WorkspaceWorkflowRun.fromDecrypted(
                Map<String, dynamic>.from(e)))
            .toList(),
        limit: m['limit'] is num ? (m['limit'] as num).toInt() : 10,
        hasMore: m['hasMore'] == true,
        error: m['error'] as String?,
      );
}

/// One entry in the workspace's file tree. `path` is workspace-relative and is
/// what the phone sends back to expand a folder.
@immutable
class WorkspaceGitTreeEntry {
  final String name;
  final String path;
  final bool isDirectory;
  final int? size;
  final bool ignored;

  const WorkspaceGitTreeEntry({
    required this.name,
    required this.path,
    required this.isDirectory,
    this.size,
    this.ignored = false,
  });

  static WorkspaceGitTreeEntry fromDecrypted(Map<String, dynamic> m) =>
      WorkspaceGitTreeEntry(
        name: (m['name'] as String?) ?? '',
        path: (m['path'] as String?) ?? '',
        isDirectory: m['kind'] == 'directory',
        size: m['size'] is num ? (m['size'] as num).toInt() : null,
        ignored: m['ignored'] == true,
      );
}

/// One directory's children. The tree is read a level at a time, as folders
/// are expanded — same as the desktop's own drawer.
@immutable
class WorkspaceGitTree {
  final String path;
  final List<WorkspaceGitTreeEntry> entries;
  final String? error;

  const WorkspaceGitTree({this.path = '', this.entries = const [], this.error});

  static WorkspaceGitTree fromDecrypted(Map<String, dynamic> m) =>
      WorkspaceGitTree(
        path: (m['path'] as String?) ?? '',
        entries: (m['entries'] is List ? (m['entries'] as List) : const [])
            .whereType<Map>()
            .map((e) => WorkspaceGitTreeEntry.fromDecrypted(
                Map<String, dynamic>.from(e)))
            .toList(),
        error: m['error'] as String?,
      );
}

/// One text file, read out of a trusted workspace for the in-app reader.
/// Mirrors `TextFileContents` on the desktop.
///
/// The bytes come down the same encrypted command as the tree, so this asks for
/// a smaller slice than the desktop reader does: a document is worth carrying,
/// a 2 MB log is not.
@immutable
class WorkspaceTextFile {
  final String path;
  final String name;
  final String content;

  /// Size on disk, which is not `content.length` when [truncated].
  final int size;
  final bool truncated;

  /// Unreadable, binary, outside the workspace, or past the cap — [content] is
  /// empty and this says why.
  final String? error;

  const WorkspaceTextFile({
    this.path = '',
    this.name = '',
    this.content = '',
    this.size = 0,
    this.truncated = false,
    this.error,
  });

  static WorkspaceTextFile fromDecrypted(Map<String, dynamic> m) =>
      WorkspaceTextFile(
        path: (m['path'] as String?) ?? '',
        name: (m['name'] as String?) ?? '',
        content: (m['content'] as String?) ?? '',
        size: m['size'] is num ? (m['size'] as num).toInt() : 0,
        truncated: m['truncated'] == true,
        error: m['error'] as String?,
      );
}

@immutable
class WorkspaceGitStatus {
  final bool isRepo;
  final String? branch;
  final int? ahead;
  final int? behind;
  final String? upstream;
  final List<WorkspaceGitRemote> remotes;
  final DateTime? lastFetchAt;
  final List<WorkspaceGitChange> changes;
  final List<String> stashes;
  final List<WorkspaceGitWorktree> worktrees;
  final List<WorkspaceGitBranch> branches;
  final List<String> folders;
  final String? error;

  const WorkspaceGitStatus({
    this.isRepo = false,
    this.branch,
    this.ahead,
    this.behind,
    this.upstream,
    this.remotes = const [],
    this.lastFetchAt,
    this.changes = const [],
    this.stashes = const [],
    this.worktrees = const [],
    this.branches = const [],
    this.folders = const [],
    this.error,
  });

  static WorkspaceGitStatus fromDecrypted(Map<String, dynamic> m) {
    List<T> list<T>(String key, T Function(Map<String, dynamic>) map) {
      final raw = m[key];
      if (raw is! List) return const [];
      return raw
          .whereType<Map>()
          .map((e) => map(Map<String, dynamic>.from(e)))
          .toList();
    }

    final lastFetchAt = m['lastFetchAt'] as String?;
    return WorkspaceGitStatus(
      isRepo: m['isRepo'] == true,
      branch: m['branch'] as String?,
      ahead: m['ahead'] is num ? (m['ahead'] as num).toInt() : null,
      behind: m['behind'] is num ? (m['behind'] as num).toInt() : null,
      upstream: m['upstream'] as String?,
      remotes: list('remotes', WorkspaceGitRemote.fromDecrypted),
      lastFetchAt: lastFetchAt != null
          ? DateTime.tryParse(lastFetchAt)?.toLocal()
          : null,
      changes: list('changes', WorkspaceGitChange.fromDecrypted),
      stashes: (m['stashes'] is List ? (m['stashes'] as List) : const [])
          .whereType<String>()
          .toList(),
      worktrees: list('worktrees', WorkspaceGitWorktree.fromDecrypted),
      branches: list('branches', WorkspaceGitBranch.fromDecrypted),
      folders: (m['folders'] is List ? (m['folders'] as List) : const [])
          .whereType<String>()
          .toList(),
      error: m['error'] as String?,
    );
  }
}
