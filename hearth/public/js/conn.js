// When the realtime connection means "signed out", and when it just needs to come back.
//
// Only two things mean this device was signed out: the server saying so ('session:revoked', sent just before it
// closes the connection) or refusing to let us back in ('unauthorized'). Any other close from the server's side
// (too many events at once, an address check, a restart) only reconnects. Socket.IO doesn't retry those by
// itself, so we do; if the sign-in really is gone, that reconnect is refused and we sign out then. (Treating
// every server-side close as a sign-out used to throw people out of the app, and wipe the keys on the device,
// after a busy call.)
export function watchConnection(socket, { onSignedOut, onDown = () => {}, paused = () => false, retryMs = 2000 } = {}) {
  let signedOut = false;
  let flooded = false;
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
  socket.on('session:revoked', (p) => signOut((p && p.reason) || 'revoked'));
  socket.on('connect_error', (e) => {
    const why = e && e.message;
    if (why === 'unauthorized') return signOut('unauthorized');
    // Let in later, not now (too many windows open, connecting too often): Socket.IO won't ask again by
    // itself after a refusal like that, so try again in a little while. (Maintenance has its own retry.)
    if (!socket.active && why !== 'maintenance' && !paused()) retry(retryMs * 5);
  });
  // Sent before the server drops a connection that sent far too much: come back, just not straight away.
  socket.on('flood', () => { flooded = true; });
  socket.on('connect', () => { flooded = false; });
  socket.on('disconnect', (reason) => {
    if (signedOut || paused()) return;
    onDown(reason);
    if (reason !== 'io server disconnect') return; // Socket.IO reconnects by itself after anything else
    retry(flooded ? retryMs * 5 : retryMs);
  });
  return { get signedOut() { return signedOut; } };
}
