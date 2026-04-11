import { invoke } from "@tauri-apps/api/core";

export interface NoteMeta {
  filename: string;
  title: string;
  modified: number;
  size: number;
}

export const getVaultPath = () => invoke<string>("get_vault_path");

export const listNotes = () => invoke<NoteMeta[]>("list_notes");

export const readNote = (filename: string) =>
  invoke<string>("read_note", { filename });

export const saveNote = (filename: string, content: string) =>
  invoke<void>("save_note", { filename, content });

export const createNote = (title: string) =>
  invoke<string>("create_note", { title });

export const deleteNote = (filename: string) =>
  invoke<void>("delete_note", { filename });
