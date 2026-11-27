# See who uses Kairos (about 10 minutes, once)

Kairos can tell you how many people installed it and which Gmail accounts signed in.
It sends this to a free database that only you can read (Google Firebase).

## 1. Make the Firebase project
1. Open https://console.firebase.google.com and sign in with your Gmail.
2. **Create a project** (or **Add Firebase to Google Cloud project** and pick the project that already holds your Kairos Google sign-in client: sign-in and database must be in the SAME project).
3. Name it `kairos`. Turn Google Analytics **off**. Press **Create project**.

## 2. Turn on the database
1. Left menu: **Build > Firestore Database > Create database**.
2. Pick a location near you (e.g. `asia-south1 (Mumbai)`), then **Start in production mode**. Create.
3. Open the **Rules** tab. Delete what is there, paste everything from `firestore.rules`, change `YOUR_EMAIL@gmail.com` to your Gmail, press **Publish**.

## 3. Turn on Google sign-in for Firebase
1. Left menu: **Build > Authentication > Get started**.
2. **Sign-in method > Google > Enable**, pick your email as support email, **Save**.
3. In the same Google box, open **Safelist client IDs from external projects**, add your Kairos client ID (the one ending in `.apps.googleusercontent.com`), **Save**.

## 4. Send two values
1. Gear icon (top left) > **Project settings > General**.
2. Copy **Project ID** and **Web API Key** and send them. (They are not passwords: the rules from step 2 keep the data private.)

They get built into the next Kairos release. Then:
- Every install is counted once, and its "last opened" day is updated once a day. No name, no email, no PC details.
- When someone signs in with Google, their email and first name are saved.
- In **your** Kairos (signed in with your Gmail): **Settings > Data & accounts > Kairos users** shows installs, opened this week, new this week, and the list of Gmail sign-ins. Everyone else only sees a "Count me in" switch.
- You can also see the raw data any time at console.firebase.google.com > Firestore Database > Data.

Note: while your Google sign-in client is in "Testing", only Gmail accounts you add as test users can sign in (Google Cloud > Google Auth Platform > Audience).
