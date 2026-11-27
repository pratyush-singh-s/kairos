# Focus 0.17.0: Google sign-in (Phase 10)

Install `Focus-0.17.0-installer.zip` over your current Focus. Everything else is kept.

## What is new

**Settings → Google account** connects Focus to your Google account. Nothing uses it yet;
Google Calendar (Phase 19) is next and builds on it.

1. Make your own free client ID once: follow `GOOGLE-SETUP.md` (about 10 minutes).
2. Paste the Client ID and Client secret in Settings and press **Save**.
3. Press **Connect Google account**. Google's page opens in your browser; sign in there.
   Focus waits up to 5 minutes and shows **Cancel** while it waits.
4. Settings shows **Connected as** your email. **Disconnect…** signs out again.

## Safety

- Focus never asks for or sees your Google password. Sign-in happens on Google's page.
- Google sends the answer back to Focus on this PC only (127.0.0.1), protected with PKCE, so a
  copied link or code cannot be used by anyone else.
- Sign-in asks only for your email. Calendar access is asked for separately later.
- The lasting sign-in is in Windows Credential Manager, not in the Focus database, and is never
  synced. Each PC connects for itself.
- Disconnect tells Google to forget it and deletes it from this PC.
