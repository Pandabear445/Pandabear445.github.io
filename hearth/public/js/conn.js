// When the realtime connection means "signed out", and when it just needs to come back.
//
// Only two things mean this device was signed out: the server saying so ('session:revoked', sent just before it
// closes the connection) or refusing to let us back in ('unauthorized'). Any other close from the server's side
// (too many events at once, an address check, a restart) only reconnects. Socket.IO doesn't retry those by
// itself, so we do; if the sign-in really is gone, that reconnect is refused and we sign out then. (Treating
// every server-side close as a sign-out used to throw people out of the app, and wipe the keys on the device,
// after a busy call.)
//
// One 'session:revoked' isn't a sign-out either: 'token_rotated'. The sign-in got a new token (a password change,
// two-factor turned on, other devices signed out), here or in another tab of this browser, and this connection
// still used the old one. tokenMoved(ms) resolves true once this tab holds a different token than the connection
// used (api.js picks up the one another tab stored); we come back with it. If none arrives, this device only had
// a copy of the old token (or lost track of the new one): that's a sign-out, said as such ('token_rotated'). A
// refusal is checked the same way first, so a tab that reconnects just as another one changes the token isn't
// signed out (which would wipe the keys every tab of this browser uses).
export function watchConnection(socket, { onSignedOut, onDown = () => {}, paused = () => false, retryMs = 2000, tokenMoved = null, rotateWaitMs = 15000 } = {}) {
  let signedOut = false;
  let flooded = false;
  let rotating = false;
  let timer = null;
  const signOut = (reason) => {
    if (signedOut) return;
    signedOut = true;
    clearTimeout(timer);
    onSignedOut(reason);
  };
  const retry = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!signedOut && !paused() && !socket.connected) socket.connect(); }, ms);
  };
  socket.on('session:revoked', (p) => {
    const reason = (p && p.reason) || 'revoked';
    if (reason !== 'token_rotated' || !tokenMoved) return signOut(reason);
    rotating = true;
    clearTimeout(timer);
    tokenMoved(rotateWaitMs).then((moved) => {
      rotating = false;
      // (The old token is known to be dead: the server only says this to connections still on one it replaced.)
      if (!moved) return signOut('token_rotated');
      if (!signedOut && !socket.connected) socket.connect();
    });
  });
  socket.on('connect_error', (e) => {
    const why = e && e.message;
    if (why === 'unauthorized') {
      if (!tokenMoved) return signOut('unauthorized');
      tokenMoved(5000).then((moved) => { if (moved && !signedOut) socket.connect(); else signOut('unauthorized'); });
      return;
    }
    // Let in later, not now (too many windows open, connecting too often): Socket.IO won't ask again by
    // itself after a refusal like that, so try again in a little while. (Maintenance has its own retry.)
    if (!socket.active && why !== 'maintenance' && !paused()) retry(retryMs * 5);
  });
  // Sent before the server drops a connection that sent far too much: come back, just not straight away.
  socket.on('flood', () => { flooded = true; });
  socket.on('connect', () => { flooded = false; rotating = false; });
  socket.on('disconnect', (reason) => {
    if (signedOut || paused()) return;
    onDown(reason);
    if (reason !== 'io server disconnect' || rotating) return; // Socket.IO reconnects by itself after anything else
    retry(flooded ? retryMs * 5 : retryMs);
  });
  return { get signedOut() { return signedOut; } };
}
