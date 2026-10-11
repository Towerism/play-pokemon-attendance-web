// nuxt-auth-utils session shape (https://github.com/atinux/nuxt-auth-utils#typing-user-session)
declare module '#auth-utils' {
  interface User {
    id: number;
    username: string;
  }

  interface UserSession {
    loggedInAt: number;
  }
}

export {};
