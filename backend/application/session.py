# -*- coding: utf-8 -*-
"""Session identity and trace coordination without protocol serialization."""
import random
import string
import threading
import time


class SessionCoordinator:
    """Own trace lifecycle while RuntimeState remains the sole sid owner."""

    def __init__(self, runtime, guard, mcp):
        self._runtime = runtime
        self._guard = guard
        self._mcp = mcp
        self._trace_id = None
        self._trace_lock = threading.RLock()

    def set_current_sid(self, sid):
        """Switch sid and invalidate both trust domains and the old trace once."""
        previous = self._runtime.get_current_sid()
        current = self._runtime.set_current_sid(sid)
        if current != previous:
            self._guard.clear_session_trust()
            self._mcp.clear_session_trust()
            with self._trace_lock:
                self._trace_id = None
        return current

    def current_trace(self):
        """Return the stable lazy t_<timestamp36>_<random4> request trace."""
        if self._trace_id is None:
            with self._trace_lock:
                if self._trace_id is None:
                    alphabet = string.digits + string.ascii_lowercase
                    number = int(time.time() * 1000)
                    timestamp = ''
                    while number:
                        number, remainder = divmod(number, 36)
                        timestamp = alphabet[remainder] + timestamp
                    suffix = ''.join(random.choice(alphabet) for _ in range(4))
                    self._trace_id = 't_' + timestamp + '_' + suffix
        return self._trace_id

    def trace_new(self):
        """Start and return a fresh trace for an explicit user-request boundary."""
        with self._trace_lock:
            self._trace_id = None
        return self.current_trace()
