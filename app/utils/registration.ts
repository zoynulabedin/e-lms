/** Sign-up constants the form (client) and the server checks share. See registration.server.ts. */

/** Name of the hidden honeypot field humans never see or fill in. */
export const HONEYPOT_FIELD = "website";

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const NAME_MAX = 60;

/** How long an emailed sign-up code (and the pending sign-up) lasts. */
export const REGISTRATION_CODE_MINUTES = 15;
