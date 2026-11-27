# Make your Google client ID (once, about 10 minutes)

Focus talks to Google with a "client ID" that belongs to you, made in your own free Google
Cloud project. Nobody else (not even the Focus developer) can use it, and nothing is billed.
You do this once; both PCs can use the same client ID.

Google renames these pages now and then. If a button has a slightly different name, look for
the closest match.

## 1. Make a project

1. Open https://console.cloud.google.com and sign in with your Google account.
2. If Google asks you to agree to the terms of service, tick the box and press **Agree and continue**.
3. At the top left, click the project picker (it may say **Select a project**), then **New project**.
4. Project name: `Focus`. Leave the location as it is. Press **Create**.
5. When it is made, click **Select project** in the notification (or pick Focus in the project picker).

## 2. Turn on the Calendar API (for the next update)

1. In the search bar at the top, type `Google Calendar API` and open it.
2. Press **Enable**.

Sign-in itself does not need this, but the Calendar update does, and it saves you coming back.

## 3. Set up the sign-in screen

1. In the search bar, type `Google Auth Platform` (older name: **OAuth consent screen**) and open it.
2. Press **Get started**.
3. **App information**: App name `Focus`, User support email = your Gmail. Press **Next**.
4. **Audience**: choose **External**. Press **Next**.
5. **Contact information**: your Gmail. Press **Next**.
6. Tick the box to agree to the user data policy, then **Continue** and **Create**.
7. In the left menu open **Audience**. Under **Test users** press **Add users**, type your Gmail,
   and press **Save**.

Optional, recommended once Calendar arrives: on the same **Audience** page press
**Publish app** and confirm. While the app is in "Testing", Google ends Calendar sign-ins
after 7 days and you would have to press Connect again every week. Publishing does not make
anything public; it only means you will see a "Google hasn't verified this app" page when you
connect (step 5 shows what to press).

## 4. Make the client ID

1. In the left menu open **Clients** (older name: **Credentials → Create credentials → OAuth client ID**).
2. Press **Create client**.
3. Application type: **Desktop app**. Name: `Focus desktop`. Press **Create**.
4. A box shows **Client ID** and **Client secret**. Press **Download JSON** as well, because
   Google may not show the secret again. Keep that file somewhere private.
   (Lost it? Open the client and press **Add secret** to make a new one.)

It must be **Desktop app**. A "Web application" client will not work with Focus.

## 5. Connect Focus

1. In Focus open **Settings → Google account**.
2. Paste the **Client ID** (ends with `.apps.googleusercontent.com`) and the **Client secret**
   (starts with `GOCSPX-`). Press **Save**.
3. Press **Connect Google account**. Your browser opens Google's own sign-in page.
4. Pick your account. If Google shows **Google hasn't verified this app**, press **Continue**
   (or **Advanced → Go to Focus (unsafe)**). It says this because the app is your own and has
   not been through Google's review; that is expected.
5. Press **Continue** / **Allow**. The tab says "Focus is connected". Close it and go back to Focus.

Settings now says **Connected as** your email.

## What Focus keeps, and how to undo it

- Your password is typed only on Google's page; Focus never sees it.
- Sign-in asks only for your email address. Calendar access will be asked for separately,
  when you turn Calendar on.
- The lasting sign-in is stored in **Windows Credential Manager** (Control Panel → Credential
  Manager → Windows Credentials → `Focus/google-refresh-token`), not in the Focus database.
- **Disconnect** in Settings tells Google to forget Focus and deletes it from this PC.
  You can also remove Focus at https://myaccount.google.com/permissions.

## If something goes wrong

| Focus says | Do this |
| --- | --- |
| "Google did not accept the client ID or secret" | Copy both again from step 4 (no spaces). Use **Change client ID**. |
| "Google rejected the return address" | The client must be **Desktop app** (step 4.3). Make a new one. |
| Google shows "Access blocked: Focus has not completed the Google verification process" | Add your Gmail as a test user (step 3.7), or publish the app. |
| "Sign-in timed out" | You have 5 minutes on Google's page. Press Connect again. |
| "could not reach Google" | Check the internet connection, then Connect again. |
