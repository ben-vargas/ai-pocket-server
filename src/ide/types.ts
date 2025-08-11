/**
 * IDE Types
 * 
 * Type definitions for IDE and Language Server Protocol functionality.
 */

// Position in a text document (0-indexed)
export interface Position {
  line: number;
  character: number;
}

// Range in a text document
export interface Range {
  start: Position;
  end: Position;
}

// Location in a file
export interface Location {
  uri: string;
  range: Range;
}

// Diagnostic severity levels
export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

// Diagnostic information
export interface Diagnostic {
  range: Range;
  message: string;
  severity?: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  relatedInformation?: DiagnosticRelatedInformation[];
}

// Related diagnostic information
export interface DiagnosticRelatedInformation {
  location: Location;
  message: string;
}

// Completion item kinds
export enum CompletionItemKind {
  Text = 1,
  Method = 2,
  Function = 3,
  Constructor = 4,
  Field = 5,
  Variable = 6,
  Class = 7,
  Interface = 8,
  Module = 9,
  Property = 10,
  Unit = 11,
  Value = 12,
  Enum = 13,
  Keyword = 14,
  Snippet = 15,
  Color = 16,
  File = 17,
  Reference = 18,
  Folder = 19,
  EnumMember = 20,
  Constant = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

// Completion item
export interface CompletionItem {
  label: string;
  kind?: CompletionItemKind;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
  command?: Command;
  data?: any;
}

// Text edit
export interface TextEdit {
  range: Range;
  newText: string;
}

// Command
export interface Command {
  title: string;
  command: string;
  arguments?: any[];
}

// Hover information
export interface HoverInfo {
  contents: string | { language: string; value: string };
  range?: Range;
}

// Symbol information
export interface SymbolInformation {
  name: string;
  kind: SymbolKind;
  location: Location;
  containerName?: string;
}

// Symbol kinds
export enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

// Language server configuration
export interface LSPConfig {
  language: string;
  command: string;
  args?: string[];
  rootPath: string;
  initializationOptions?: any;
}

// Language server status
export interface LSPStatus {
  language: string;
  status: 'starting' | 'ready' | 'error' | 'stopped';
  error?: string;
}