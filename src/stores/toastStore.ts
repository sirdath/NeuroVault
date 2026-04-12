import { create } from "zustand";

export interface Toast {
  id: string;
  type: "info" | "success" | "warning" | "error";
  message: string;
  createdAt: number;
}

interface ToastStore {
  toasts: Toast[];
  show: (message: string, type?: Toast["type"]) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (message, type = "info") => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const toast: Toast = { id, type, message, createdAt: Date.now() };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

// Convenience exports
export const toast = {
  info: (msg: string) => useToastStore.getState().show(msg, "info"),
  success: (msg: string) => useToastStore.getState().show(msg, "success"),
  warning: (msg: string) => useToastStore.getState().show(msg, "warning"),
  error: (msg: string) => useToastStore.getState().show(msg, "error"),
};
