import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

// The video element every lightbox in the app uses, with the keyboard on top of
// it. Native `<video controls>` in Chromium only answers the keyboard while the
// element itself has focus, and clicking anywhere else in the dialog (or just
// opening it from a card) leaves focus elsewhere — so the shortcuts live on a
// window-level capture listener for as long as a player is mounted instead.

/** The playback speeds `a`/`d` step through, slowest first. */
export const PLAYBACK_RATES = [0.5, 1, 2, 4, 8] as const;

const SEEK_SECONDS = 5;
const SEEK_SECONDS_FINE = 1;
const SEEK_SECONDS_COARSE = 10;
const VOLUME_STEP = 0.1;
const HUD_MS = 900;

/**
 * The next speed in {@link PLAYBACK_RATES} in `direction`, clamped at both ends.
 * A rate that is not one of the steps (nothing sets one today, but a restored
 * `<video>` can carry one) snaps to the nearest step first, so the first press
 * always lands somewhere sensible.
 */
export function stepPlaybackRate(current: number, direction: 1 | -1): number {
  const nearest = PLAYBACK_RATES.reduce((best, rate) =>
    Math.abs(rate - current) < Math.abs(best - current) ? rate : best,
  );
  const index = PLAYBACK_RATES.indexOf(nearest);
  const next = index + direction;
  if (next < 0 || next >= PLAYBACK_RATES.length) {
    return nearest;
  }
  return PLAYBACK_RATES[next] ?? nearest;
}

/** `1x`, `0.5x` — the speed as the HUD writes it. */
export function formatPlaybackRate(rate: number): string {
  return `${Number.isInteger(rate) ? rate : rate.toString()}x`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

type VideoPlayerProps = {
  src: string;
  /** Announced by the wrapper, for the same reason the `<img>` beside it has alt text. */
  label?: string;
  autoPlay?: boolean;
};

export function VideoPlayer({ src, label, autoPlay = true }: VideoPlayerProps): ReactElement {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hud, setHud] = useState<string | null>(null);
  const hudTimerRef = useRef<number | null>(null);

  const flash = useCallback((message: string) => {
    setHud(message);
    if (hudTimerRef.current !== null) {
      window.clearTimeout(hudTimerRef.current);
    }
    hudTimerRef.current = window.setTimeout(() => setHud(null), HUD_MS);
  }, []);

  useEffect(
    () => () => {
      if (hudTimerRef.current !== null) {
        window.clearTimeout(hudTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const toggleFullscreen = (): void => {
      const wrap = wrapRef.current;
      if (!wrap) {
        return;
      }
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        // The wrapper rather than the `<video>`, so the speed HUD stays visible
        // over a fullscreen player.
        void wrap.requestFullscreen();
      }
    };

    const onKey = (event: KeyboardEvent): void => {
      const video = videoRef.current;
      if (!video || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
        return;
      }

      // Escape belongs to fullscreen while fullscreen is up: without this the
      // app's global Escape handler also fires and closes the lightbox out from
      // under the exit, so one press loses the video entirely.
      if (event.key === "Escape") {
        if (document.fullscreenElement) {
          event.preventDefault();
          // Immediate: the lightbox's own Escape handler is on this same target,
          // so plain stopPropagation would not keep it from firing.
          event.stopImmediatePropagation();
          void document.exitFullscreen();
        }
        return;
      }

      const seek = (delta: number): void => {
        const duration = Number.isFinite(video.duration) ? video.duration : null;
        const next = Math.max(0, video.currentTime + delta);
        video.currentTime = duration === null ? next : Math.min(duration, next);
      };

      let handled = true;
      switch (event.key) {
        case " ":
        case "k":
        case "K":
          if (video.paused) {
            void video.play();
            flash("Play");
          } else {
            video.pause();
            flash("Pause");
          }
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "a":
        case "A": {
          const rate = stepPlaybackRate(video.playbackRate, 1);
          video.playbackRate = rate;
          flash(formatPlaybackRate(rate));
          break;
        }
        case "d":
        case "D": {
          const rate = stepPlaybackRate(video.playbackRate, -1);
          video.playbackRate = rate;
          flash(formatPlaybackRate(rate));
          break;
        }
        case "s":
        case "S":
          video.playbackRate = 1;
          flash(formatPlaybackRate(1));
          break;
        case "m":
        case "M":
          video.muted = !video.muted;
          flash(video.muted ? "Muted" : "Unmuted");
          break;
        case "ArrowRight":
          seek(event.shiftKey ? SEEK_SECONDS_FINE : SEEK_SECONDS);
          break;
        case "ArrowLeft":
          seek(-(event.shiftKey ? SEEK_SECONDS_FINE : SEEK_SECONDS));
          break;
        case "l":
        case "L":
          seek(SEEK_SECONDS_COARSE);
          break;
        case "j":
        case "J":
          seek(-SEEK_SECONDS_COARSE);
          break;
        case "ArrowUp":
          video.volume = Math.min(1, video.volume + VOLUME_STEP);
          video.muted = false;
          flash(`Volume ${Math.round(video.volume * 100)}%`);
          break;
        case "ArrowDown":
          video.volume = Math.max(0, video.volume - VOLUME_STEP);
          flash(`Volume ${Math.round(video.volume * 100)}%`);
          break;
        case "0":
        case "Home":
          video.currentTime = 0;
          break;
        default:
          handled = false;
      }

      if (handled) {
        // Space scrolls, and the native controls would otherwise act on the same
        // key a second time when the `<video>` happens to hold focus.
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [flash]);

  return (
    <div className="video-player" ref={wrapRef}>
      <video ref={videoRef} src={src} controls autoPlay={autoPlay} aria-label={label} />
      {hud ? (
        <div className="video-player-hud" role="status">
          {hud}
        </div>
      ) : null}
    </div>
  );
}
