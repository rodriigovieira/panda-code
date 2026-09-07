import { describe, expect, it } from "vitest";
import { attributeSessions, collectSectionCommands, parseDf, parsePsTable, parseSwapUsage, parseVmStat } from "./machine-probe";
import { formatBytes, machinePressure, renderMachineStats, type MachineStats } from "./machine-stats";

const GB = 1024 ** 3;

const stats = (partial: Partial<MachineStats> = {}): MachineStats => ({
  capturedAt: "2026-08-03T00:00:00.000Z",
  hostname: "panda",
  platform: "darwin",
  uptimeSec: 3600,
  cpuCount: 8,
  loadAvg: [1, 1, 1],
  cpuPct: 20,
  memTotalBytes: 8 * GB,
  memAvailableBytes: 4 * GB,
  memUsedPct: 50,
  swapUsedBytes: null,
  swapTotalBytes: null,
  diskUsedPct: null,
  diskFreeBytes: null,
  topByCpu: [],
  topByMemory: [],
  sectionCommands: [],
  ...partial,
});

describe("parsePsTable", () => {
  it("keeps spaces in the command column and reports RSS in bytes", () => {
    const rows = parsePsTable(
      [
        "42939 42935  37.4 140144 /Applications/Panda Code.app/Contents/MacOS/Panda Code Helper (Renderer)",
        "  403     1  36.8  41968 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
        "not a process row",
      ].join("\n"),
      8 * GB,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      pid: 42939,
      ppid: 42935,
      name: "Panda Code Helper (Renderer)",
      cpuPct: 37.4,
      rssBytes: 140144 * 1024,
    });
    expect(rows[1]!.name).toBe("WindowServer");
  });
});

describe("parseVmStat", () => {
  it("counts inactive and speculative pages as available", () => {
    const parsed = parseVmStat(
      [
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
        "Pages free:                                3533.",
        "Pages active:                             88120.",
        "Pages inactive:                           82999.",
        "Pages speculative:                         4496.",
        "Pages purgeable:                              2.",
        "Pages wired down:                        102163.",
        "Pages occupied by compressor:            120000.",
      ].join("\n"),
    );
    expect(parsed?.availableBytes).toBe((3533 + 82999 + 4496 + 2) * 16384);
    expect(parsed?.compressedBytes).toBe(120000 * 16384);
    // Wired is deliberately NOT part of `available`: it is unreclaimable.
    expect(parsed?.wiredBytes).toBe(102163 * 16384);
  });

  it("reports wired as zero when vm_stat omits it, rather than failing to parse", () => {
    const parsed = parseVmStat(
      ["Mach Virtual Memory Statistics: (page size of 4096 bytes)", "Pages free:  100."].join("\n"),
    );
    expect(parsed?.wiredBytes).toBe(0);
  });

  it("returns null when the page size is missing", () => {
    expect(parseVmStat("nothing useful here")).toBeNull();
  });
});

describe("parseSwapUsage", () => {
  it("scales the M suffix", () => {
    expect(parseSwapUsage("total = 6144.00M  used = 5091.94M  free = 1052.06M  (encrypted)")).toEqual({
      usedBytes: Math.round(5091.94 * 1024 ** 2),
      totalBytes: 6144 * 1024 ** 2,
    });
  });
});

describe("parseDf", () => {
  it("reads the capacity column and the free blocks", () => {
    const parsed = parseDf(
      ["Filesystem     1024-blocks      Used Available Capacity  Mounted on", "/dev/disk3s1s1   482797652  11002928  34798184    25%    /"].join(
        "\n",
      ),
    );
    expect(parsed).toEqual({ usedPct: 25, freeBytes: 34798184 * 1024 });
  });

  // Verbatim `df -kP /System/Volumes/Data` from the machine where the usage card
  // was found reporting 22% used. Its `/` row at that same moment read 22% with
  // an identical Available (both volumes share one APFS container), so 90% here
  // is the figure the card should have shown — the mount point, not the parsing,
  // was what made it wrong. The fixture above is a different box and is only
  // exercising the plain-`/` layout.
  it("reads the macOS data volume, whose mount point has slashes in it", () => {
    const parsed = parseDf(
      [
        "Filesystem     1024-blocks      Used Available Capacity  Mounted on",
        "/dev/disk3s5     482797652 407364036  46395988    90%    /System/Volumes/Data",
      ].join("\n"),
    );
    expect(parsed).toEqual({ usedPct: 90, freeBytes: 46395988 * 1024 });
  });
});

describe("attributeSessions", () => {
  it("walks a grandchild up to the section that owns its shell", () => {
    const rows = parsePsTable(
      ["100 1 1.0 1000 /bin/zsh", "200 100 2.0 2000 /usr/bin/node", "300 200 90.0 3000 /usr/bin/tsc", "400 1 1.0 500 /usr/sbin/cupsd"].join("\n"),
      8 * GB,
    );
    attributeSessions(rows, new Map([[100, "section-a"]]));
    expect(rows.map((row) => row.sessionId)).toEqual(["section-a", "section-a", "section-a", undefined]);
  });

  it("does nothing when no session pids are known", () => {
    const rows = parsePsTable("100 1 1.0 1000 /bin/zsh", 8 * GB);
    attributeSessions(rows, new Map());
    expect(rows[0]!.sessionId).toBeUndefined();
  });
});

describe("collectSectionCommands", () => {
  /** section root 100 → `sh -c pnpm build` 200 → tsc 300, plus an unrelated daemon. */
  const tree = (): ReturnType<typeof parsePsTable> => {
    const rows = parsePsTable(
      [
        "100 1 1.0 1000 /bin/zsh",
        "200 100 0.0 2000 /bin/sh",
        "300 200 90.0 3000 /usr/bin/tsc",
        "400 1 1.0 500 /usr/sbin/cupsd",
      ].join("\n"),
      8 * GB,
    );
    attributeSessions(rows, new Map([[100, "section-a"]]));
    return rows;
  };

  it("reports the spawned command, not the agent and not its grandchildren", () => {
    expect(collectSectionCommands(tree()).map((row) => row.pid)).toEqual([200]);
  });

  it("credits a command with its whole subtree, so an idle shell over a busy tsc still ranks", () => {
    const [command] = collectSectionCommands(tree());
    expect(command!.cpuPct).toBe(90);
    expect(command!.rssBytes).toBe(5000 * 1024);
  });

  it("is empty when no process belongs to a section", () => {
    const rows = parsePsTable("400 1 1.0 500 /usr/sbin/cupsd", 8 * GB);
    expect(collectSectionCommands(rows)).toEqual([]);
  });
});

describe("machinePressure", () => {
  it("calls a box loaded on memory alone, even when the CPU is idle", () => {
    expect(machinePressure(stats({ loadAvg: [0.2, 0.2, 0.2], memUsedPct: 95 }))).toBe("loaded");
    expect(machinePressure(stats({ loadAvg: [0.2, 0.2, 0.2], memUsedPct: 85 }))).toBe("busy");
    expect(machinePressure(stats())).toBe("quiet");
  });

  it("reads load against core count, not raw", () => {
    expect(machinePressure(stats({ loadAvg: [7, 7, 7], cpuCount: 8, memUsedPct: 10 }))).toBe("busy");
    expect(machinePressure(stats({ loadAvg: [14, 14, 14], cpuCount: 8, memUsedPct: 10 }))).toBe("loaded");
  });
});

describe("renderMachineStats", () => {
  it("names the owning section and warns when saturated", () => {
    const text = renderMachineStats(
      stats({
        loadAvg: [16, 12, 9],
        memUsedPct: 96,
        topByCpu: [
          { pid: 42, ppid: 1, name: "tsc", cpuPct: 320, rssBytes: 900 * 1024 * 1024, memPct: 11, sessionId: "abcdef12-9999" },
        ],
        topByMemory: [{ pid: 42, ppid: 1, name: "tsc", cpuPct: 320, rssBytes: 900 * 1024 * 1024, memPct: 11 }],
      }),
    );
    expect(text).toContain("section abcdef12");
    expect(text).toContain("Heaviest by memory:");
    expect(text).toContain("box is saturated");
  });

  it("degrades to one line when the probe itself failed", () => {
    expect(renderMachineStats(stats({ error: "ps: command not found" }))).toBe(
      "Could not read machine state: ps: command not found",
    );
  });
});

describe("formatBytes", () => {
  it("keeps one decimal below ten and none above", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(64 * 1024 * 1024)).toBe("64 MB");
    expect(formatBytes(null)).toBe("—");
  });
});
