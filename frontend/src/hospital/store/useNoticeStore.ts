import { create } from 'zustand';

/** A short message shown at the bottom of the screen, e.g. when the server refuses an action. */
interface NoticeState {
  message: string | null;
  kind: 'error' | 'info';
  show: (message: string, kind?: 'error' | 'info') => void;
  clear: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useNoticeStore = create<NoticeState>((set) => ({
  message: null,
  kind: 'info',
  show: (message, kind = 'error') => {
    clearTimeout(timer);
    set({ message, kind });
    timer = setTimeout(() => set({ message: null }), 7000);
  },
  clear: () => set({ message: null }),
}));

/** Report a failed call to the person using the screen. */
export function reportError(error: unknown): void {
  useNoticeStore.getState().show(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
}
