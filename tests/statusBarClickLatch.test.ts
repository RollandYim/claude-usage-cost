import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createStatusBarClickLatch,
  DEFAULT_DOUBLE_CLICK_WINDOW_MS,
} from '../src/statusBarClickLatch';

const mockLogger = {
  appendLine: (_msg: string) => { /* noop */ },
  append: (_msg: string) => { /* noop */ },
  show: () => { /* noop */ },
  hide: () => { /* noop */ },
  dispose: () => { /* noop */ },
  clear: () => { /* noop */ },
  replace: (_value: string) => { /* noop */ },
  name: 'test',
} as unknown as import('vscode').OutputChannel;

describe('createStatusBarClickLatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function build(opts?: {
    onSingle?: () => void;
    onDouble?: () => void;
  }) {
    const onSingleClick = opts?.onSingle ?? vi.fn();
    const onDoubleClick = opts?.onDouble ?? vi.fn();
    const latch = createStatusBarClickLatch({
      now: () => Date.now(),
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h),
      onSingleClick,
      onDoubleClick,
      logger: mockLogger,
    });
    return { latch, onSingleClick, onDoubleClick };
  }

  it('single click fires onSingleClick after the double-click window', () => {
    const { latch, onSingleClick, onDoubleClick } = build();
    latch.onClick();
    expect(onSingleClick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_WINDOW_MS);
    expect(onSingleClick).toHaveBeenCalledTimes(1);
    expect(onDoubleClick).toHaveBeenCalledTimes(0);
  });

  it('two clicks within the window fire onDoubleClick and cancel single-click', () => {
    const { latch, onSingleClick, onDoubleClick } = build();
    latch.onClick();
    vi.advanceTimersByTime(100);
    latch.onClick();
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    expect(onSingleClick).toHaveBeenCalledTimes(0);
    // Flush any stray pending timers — nothing should fire.
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_WINDOW_MS * 2);
    expect(onSingleClick).toHaveBeenCalledTimes(0);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('third click inside the quiet window is dropped', () => {
    const { latch, onSingleClick, onDoubleClick } = build();
    latch.onClick();
    vi.advanceTimersByTime(50);
    latch.onClick();
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    latch.onClick();
    // Inside quiet window → ignored entirely.
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    expect(onSingleClick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_WINDOW_MS * 2);
    expect(onSingleClick).toHaveBeenCalledTimes(0);
  });

  it('click resumes normally after the quiet window elapses', () => {
    const { latch, onSingleClick, onDoubleClick } = build();
    latch.onClick();
    vi.advanceTimersByTime(50);
    latch.onClick();
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    latch.onClick();
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_WINDOW_MS);
    expect(onSingleClick).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels pending single-click timer', () => {
    const { latch, onSingleClick, onDoubleClick } = build();
    latch.onClick();
    latch.dispose();
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_WINDOW_MS * 2);
    expect(onSingleClick).toHaveBeenCalledTimes(0);
    expect(onDoubleClick).toHaveBeenCalledTimes(0);
  });

  it('dispose is idempotent', () => {
    const { latch } = build();
    latch.onClick();
    latch.dispose();
    expect(() => latch.dispose()).not.toThrow();
  });

  it('swallows errors from onSingleClick without rethrowing', () => {
    const throwing = vi.fn(() => {
      throw new Error('boom-single');
    });
    const { latch, onDoubleClick } = build({ onSingle: throwing });
    latch.onClick();
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_WINDOW_MS);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(onDoubleClick).toHaveBeenCalledTimes(0);
    // Latch remains usable after the error.
    latch.onClick();
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_WINDOW_MS);
    expect(throwing).toHaveBeenCalledTimes(2);
  });

  it('swallows errors from onDoubleClick without rethrowing', () => {
    const throwing = vi.fn(() => {
      throw new Error('boom-double');
    });
    const { latch, onSingleClick } = build({ onDouble: throwing });
    latch.onClick();
    vi.advanceTimersByTime(50);
    latch.onClick();
    expect(throwing).toHaveBeenCalledTimes(1);
    // No pending timer should remain.
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_WINDOW_MS * 2);
    expect(onSingleClick).toHaveBeenCalledTimes(0);
  });

  it('respects custom doubleClickWindowMs', () => {
    const onSingleClick = vi.fn();
    const onDoubleClick = vi.fn();
    const latch = createStatusBarClickLatch({
      now: () => Date.now(),
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h),
      onSingleClick,
      onDoubleClick,
      logger: mockLogger,
      doubleClickWindowMs: 100,
    });
    latch.onClick();
    vi.advanceTimersByTime(99);
    expect(onSingleClick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(onSingleClick).toHaveBeenCalledTimes(1);
  });
});
