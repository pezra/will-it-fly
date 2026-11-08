// Core has no DOM lib, so declare the only console methods it may use.
// Declared as an interface merge so it coexists with lib.dom in the app config.
interface Console {
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}
declare var console: Console;
