/**
 * A shared, debounced, *serialized* autosave for a document context.
 *
 * Several independent features (floating notes, side-by-side layout, …) persist
 * their state by writing cell metadata and then asking the notebook to save.
 * If each of them calls `context.save()` on its own timer, two saves can be in
 * flight on the same file at once. On a slow or network-backed filesystem the
 * second save's "has this changed on disk?" check runs *after* the first save
 * has already written a newer timestamp, and JupyterLab raises a spurious
 * "File Changed / Revert / Overwrite" conflict dialog even though nothing
 * external touched the file.
 *
 * Routing every feature's save request through this coordinator guarantees at
 * most one `save()` is ever in progress per context: requests are debounced
 * into a single timer, and any request that arrives while a save is running is
 * coalesced into exactly one follow-up save.
 */

/** The slice of a document context this coordinator needs. */
interface ISaveable {
  readonly isDisposed: boolean;
  save(): Promise<void>;
}

interface ISaveState {
  timer: number;
  inFlight: boolean;
  again: boolean;
}

const DEBOUNCE_MS = 800;

// Keyed on the context object itself, so state is shared across every feature
// that saves the same notebook and is dropped when the context is collected.
const states = new WeakMap<object, ISaveState>();

/** Ask for the context to be saved soon, coalescing with any other requests. */
export function requestContextSave(context: ISaveable | null | undefined): void {
  if (!context || context.isDisposed) {
    return;
  }
  let state = states.get(context);
  if (!state) {
    state = { timer: 0, inFlight: false, again: false };
    states.set(context, state);
  }
  const s = state;
  if (s.timer) {
    window.clearTimeout(s.timer);
  }
  s.timer = window.setTimeout(() => {
    s.timer = 0;
    void run(context, s);
  }, DEBOUNCE_MS);
}

async function run(context: ISaveable, s: ISaveState): Promise<void> {
  if (context.isDisposed) {
    return;
  }
  // Never start a second save while one is running; remember that more work
  // arrived so we can flush it once the current save settles.
  if (s.inFlight) {
    s.again = true;
    return;
  }
  s.inFlight = true;
  try {
    await context.save();
  } catch {
    /* a failed autosave shouldn't disrupt editing */
  } finally {
    s.inFlight = false;
    if (s.again) {
      s.again = false;
      if (!s.timer) {
        s.timer = window.setTimeout(() => {
          s.timer = 0;
          void run(context, s);
        }, DEBOUNCE_MS);
      }
    }
  }
}
