/**
 * Minimal controllable WebSocket for tests — jsdom has no WebSocket
 * implementation. Tests drive connection state via `open()` / `receive()` /
 * `fail()` / `close()` and inspect the URLs passed to the constructor
 * (e.g. asserting the agent token is embedded in `?token=`).
 */
export class MockWebSocket {
  static instances: MockWebSocket[] = [];

  /** Clear the instance registry (call between tests). */
  static reset() {
    MockWebSocket.instances = [];
  }

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  /** True once `close()` has been called (by the hook or a test). */
  closed = false;

  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  /** Test helper: simulate a successful handshake (fires `onopen`). */
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  /** Test helper: deliver a server frame to `onmessage`. */
  receive(data: unknown) {
    this.onmessage?.({ data });
  }

  /** Test helper: simulate the server dropping the connection (error → close). */
  fail() {
    this.readyState = MockWebSocket.CLOSED;
    this.onerror?.({});
    this.onclose?.({});
  }

  /** Close like the browser would: fires `onclose` unless already closed. */
  close() {
    this.closed = true;
    if (this.readyState !== MockWebSocket.CLOSED) {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.({});
    }
  }
}
