// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and state names, the status of
// the integration, the answers of the buttons and the command errors. None of
// them ever carries the key, the user id, the e-mail address or the password.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts, one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return both(`${seconds} s`, `${seconds} s`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return both(`${minutes} min`, `${minutes} min`);
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const FEATURE_NAMES = {
  [FEATURES.STATUS]: both('Status', 'État'),
  [FEATURES.FLAME_ON]: both('Flame on', 'Flamme allumée'),
  [FEATURES.PILOT]: both('Continuous pilot', 'Veilleuse permanente'),
  [FEATURES.HOT]: both('Glass hot', 'Vitre chaude'),
  [FEATURES.TEMPERATURE]: both('Room temperature', 'Température de la pièce'),
  [FEATURES.THERMOSTAT_ON]: both('Thermostat mode', 'Mode thermostat'),
  [FEATURES.TIMER_LEFT]: both('Timer left', 'Minuterie restante'),
  [FEATURES.LIGHT_LEVEL]: both('Light level', "Niveau d'éclairage"),
  [FEATURES.ERROR]: both('Fault reported', 'Défaut signalé'),
  [FEATURES.ERRORS]: both('Faults', 'Défauts'),
  [FEATURES.TURN_ON]: both('Turn on (gas flame)', 'Allumer (flamme de gaz)'),
  [FEATURES.TURN_OFF]: both('Turn off', 'Éteindre'),
  [FEATURES.FLAME_HEIGHT]: both('Flame height', 'Hauteur de flamme'),
  [FEATURES.FAN_SPEED]: both('Fan speed', 'Vitesse du ventilateur'),
  [FEATURES.SETPOINT]: both('Thermostat setpoint', 'Consigne du thermostat'),
};

export const STATE_NAMES = {
  off: both('Off', 'Éteint'),
  offHot: both('Off, glass still hot', 'Éteint, vitre encore chaude'),
  on: both('Flame on', 'Flamme allumée'),
  onHeight: (h) => both(`Flame on, height ${h}/5`, `Flamme allumée, hauteur ${h}/5`),
  unknown: both('Unknown state', 'État inconnu'),
  offline: both('Fireplace unreachable', 'Foyer injoignable'),
  fanOff: both('Off', 'Arrêt'),
};

/** The error codes (intellifire4py IntelliFireErrorCode, from the app). */
export const ERROR_NAMES = {
  none: both('None', 'Aucun'),
  pilot_flame: both('Pilot flame error', 'Défaut de veilleuse'),
  flame: both('Flame error', 'Défaut de flamme'),
  fan_delay: both('Fan starts within 3 min', 'Ventilateur dans 3 min'),
  maintenance: both('Maintenance due', 'Entretien à prévoir'),
  disabled: both('Appliance disabled', 'Appareil désactivé'),
  fan: both('Fan error', 'Défaut du ventilateur'),
  lights: both('Lights error', "Défaut de l'éclairage"),
  accessory: both('Accessory error', "Défaut d'accessoire"),
  soft_lock_out: both('Did not start (soft lock-out)', "N'a pas démarré (verrouillage)"),
  offline: both('Appliance offline', 'Appareil hors ligne'),
  ecm_offline: both('ECM offline', 'ECM hors ligne'),
};

/** The status of the configuration screen, and the answers of its buttons. */
export const T = {
  noAddress: both(
    'Enter the address of the fireplace, then save.',
    "Saisissez l'adresse du foyer, puis enregistrez.",
  ),
  badAddress: (text) =>
    both(
      `"${text}" is not an address (IPv4 or host name).`,
      `« ${text} » n'est pas une adresse (IPv4 ou nom d'hôte).`,
    ),
  addressWithAt: both(
    'The address holds an "@": enter only the IPv4 address or host name.',
    "L'adresse contient un « @ » : saisissez seulement l'adresse IPv4 ou le nom d'hôte.",
  ),
  configUnreadable: both(
    'The configuration cannot be read from Gladys: tried again every 30 s.',
    'La configuration ne peut pas être lue depuis Gladys : nouvel essai toutes les 30 s.',
  ),
  connecting: both('Connecting to the fireplace...', 'Connexion au foyer...'),
  waiting: (wait) =>
    both(
      `First read in ${wait.en} (not sooner than the interval).`,
      `Première lecture dans ${wait.fr} (pas avant l'intervalle).`,
    ),
  connected: (summary) => both(`Connected: ${summary.en}.`, `Connecté : ${summary.fr}.`),
  summary: (serial, state) =>
    both(
      `fireplace ${serial}, ${state.en.toLowerCase()}`,
      `foyer ${serial}, ${state.fr.toLowerCase()}`,
    ),
  unreachable: (reason, wait) =>
    both(
      `Fireplace unreachable (${reason}); next try in ${wait.en}.`,
      `Foyer injoignable (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  noIdentity: both(
    'The device at this address gives no serial number: is it an IntelliFire module?',
    "L'appareil à cette adresse ne donne pas de numéro de série : est-ce un module IntelliFire ?",
  ),
  paused: (wait) =>
    both(
      `The fireplace asked to wait: next read in ${wait.en} (turning off still goes).`,
      `Le foyer a demandé d'attendre : prochaine lecture dans ${wait.fr} (l'extinction part quand même).`,
    ),
  noCredentials: both(
    'Read only: no key and user id yet (fill them in, or use "Retrieve the key").',
    "Lecture seule : pas encore de clé ni d'identifiant (saisissez-les, ou utilisez « Récupérer la clé »).",
  ),
  badCredentials: both(
    'The key or the user id is not valid (key: hex digits; both needed).',
    "La clé ou l'identifiant n'est pas valide (clé : caractères hexadécimaux ; les deux sont nécessaires).",
  ),
  keyRefused: both(
    'The fireplace refused the key or the user id (ten 403s, a key it never accepted): save them again, test the connection or use "Retrieve the key".',
    "Le foyer a refusé la clé ou l'identifiant (dix 403, une clé jamais acceptée) : enregistrez-les à nouveau, testez la connexion ou utilisez « Récupérer la clé ».",
  ),
  stopPending: (since) =>
    both(
      `A turn off from Gladys (${since.en} ago) is not seen applied yet: checked again (every 15 s, spaced up to 1 h only while the module answers 403).`,
      `Une extinction depuis Gladys (il y a ${since.fr}) n'est pas encore vue appliquée : vérifiée à nouveau (toutes les 15 s, espacé jusqu'à 1 h seulement tant que le module répond 403).`,
    ),
  stopWaitsKey: both(
    'A turn off waits for a valid key and user id in the configuration: it leaves as soon as they are saved.',
    "Une extinction attend une clé et un identifiant valides dans la configuration : elle part dès qu'ils sont enregistrés.",
  ),
  stopKeyRefused: both(
    'A turn off waits: the fireplace refused the key or the user id (ten 403s): save the key again or test the connection.',
    "Une extinction attend : le foyer a refusé la clé ou l'identifiant (dix 403) : enregistrez à nouveau la clé ou testez la connexion.",
  ),
  stopOtherSerial: both(
    'A turn off waits for this fireplace: another one (another serial number) answers at the address.',
    "Une extinction attend ce foyer : un autre (autre numéro de série) répond à l'adresse.",
  ),
  stopHeld: both(
    'A turn off was posted 4 times and the fireplace still shows the flame: no more posts until a new click (check the fireplace).',
    "Une extinction a été envoyée 4 fois et le foyer montre toujours la flamme : plus d'envoi avant un nouveau clic (vérifiez le foyer).",
  ),
  otherSerial: both(
    'Another fireplace answers at this address than the one read before.',
    'Un autre foyer que celui lu auparavant répond à cette adresse.',
  ),
  lastRead: (ago) => both(`(read ${ago.en} ago)`, `(lu il y a ${ago.fr})`),
  nextRead: (wait) => both(`Next read in ${wait.en}.`, `Prochaine lecture dans ${wait.fr}.`),
  // "Retrieve the key" button.
  noAccount: both(
    'Enter the e-mail address and password of the IntelliFire account, save, then click again.',
    "Saisissez l'adresse e-mail et le mot de passe du compte IntelliFire, enregistrez, puis cliquez à nouveau.",
  ),
  badAccount: both(
    'The e-mail address or the password is not valid (both needed).',
    "L'adresse e-mail ou le mot de passe n'est pas valide (les deux sont nécessaires).",
  ),
  readFirst: both(
    'Read the fireplace first (its address saved and reachable): its serial number picks its key.',
    "Lisez d'abord le foyer (adresse enregistrée et joignable) : son numéro de série choisit sa clé.",
  ),
  tooSoon: (wait) =>
    both(
      `One try per click: click again in ${wait.en}.`,
      `Un essai par clic : cliquez à nouveau dans ${wait.fr}.`,
    ),
  cloudRefused: both(
    'The IntelliFire account refused the e-mail address or the password. Nothing is tried again by itself.',
    "Le compte IntelliFire a refusé l'adresse e-mail ou le mot de passe. Rien n'est réessayé de lui-même.",
  ),
  cloudFailed: (reason) =>
    both(
      `The IntelliFire cloud did not answer as expected (${reason}).`,
      `Le cloud IntelliFire n'a pas répondu comme prévu (${reason}).`,
    ),
  notInAccount: (count) =>
    both(
      `No fireplace of the account (${count} found) has the serial number read at this address.`,
      `Aucun foyer du compte (${count} trouvé(s)) n'a le numéro de série lu à cette adresse.`,
    ),
  keySaved: both(
    'Key and user id retrieved and saved in Gladys: the commands may now be signed. You may now erase the password.',
    'Clé et identifiant récupérés et enregistrés dans Gladys : les commandes peuvent maintenant être signées. Vous pouvez maintenant effacer le mot de passe.',
  ),
  keyNotSaved: (reason) =>
    both(
      `Key retrieved but not saved in Gladys (${reason}): click again.`,
      `Clé récupérée mais non enregistrée dans Gladys (${reason}) : cliquez à nouveau.`,
    ),
};

/** The errors of the commands, shown by Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badButton: both('A button only takes 1.', "Un bouton n'accepte que 1."),
  badValue: (low, high) =>
    both(
      `A whole number from ${low} to ${high} is expected.`,
      `Un nombre entier de ${low} à ${high} est attendu.`,
    ),
  disabled: both(
    'Turning on, the flame, the fan and the setpoint from Gladys are not allowed (configuration). Turning off always goes.',
    "Allumer, la flamme, le ventilateur et la consigne depuis Gladys ne sont pas autorisés (configuration). L'extinction part toujours.",
  ),
  noAddress: both(
    'No address of the fireplace: nothing sent.',
    'Aucune adresse de foyer : rien envoyé.',
  ),
  notReadYet: both(
    'The configuration is not read yet: nothing sent.',
    "La configuration n'est pas encore lue : rien envoyé.",
  ),
  noCredentials: both(
    'No key and user id: nothing sent.',
    "Pas de clé ni d'identifiant : rien envoyé.",
  ),
  unknownFireplace: both(
    'Not the configured fireplace: nothing sent.',
    "Ce n'est pas le foyer configuré : rien envoyé.",
  ),
  otherFireplace: both(
    'The fireplace at the address is not this device (another serial number): nothing sent.',
    "Le foyer à l'adresse n'est pas cet appareil (autre numéro de série) : rien envoyé.",
  ),
  stillRunning: both(
    'Another command is running: nothing sent.',
    'Une autre commande est en cours : rien envoyé.',
  ),
  stopMeanwhile: both(
    'A turn off was clicked meanwhile: nothing sent.',
    'Une extinction a été cliquée entre-temps : rien envoyé.',
  ),
  stopInProgress: both(
    'A turn off is in progress: nothing sent.',
    'Une extinction est en cours : rien envoyé.',
  ),
  paused: (wait) =>
    both(
      `The fireplace asked to wait ${wait.en}: nothing sent.`,
      `Le foyer a demandé d'attendre ${wait.fr} : rien envoyé.`,
    ),
  keyRefused: both(
    'The fireplace refuses the key or the user id: nothing sent.',
    "Le foyer refuse la clé ou l'identifiant : rien envoyé.",
  ),
  tooSlow: both(
    'The fireplace did not answer in time: nothing sent.',
    "Le foyer n'a pas répondu à temps : rien envoyé.",
  ),
  unknownState: (reason) =>
    both(
      `The state of the fireplace could not be read (${reason}): nothing sent.`,
      `L'état du foyer n'a pas pu être lu (${reason}) : rien envoyé.`,
    ),
  missing: both(
    'A value needed is missing from the read: nothing sent.',
    'Une valeur nécessaire manque à la lecture : rien envoyé.',
  ),
  faults: (text) =>
    both(
      `The fireplace reports a fault (${text.en}): nothing sent.`,
      `Le foyer signale un défaut (${text.fr}) : rien envoyé.`,
    ),
  isOff: both(
    'The fireplace is off: turn it on first (this never lights it): nothing sent.',
    "Le foyer est éteint : allumez-le d'abord (ceci ne l'allume jamais) : rien envoyé.",
  ),
  noFan: both(
    'This fireplace has no fan: nothing sent.',
    "Ce foyer n'a pas de ventilateur : rien envoyé.",
  ),
  noThermostat: both(
    'This fireplace has no thermostat: nothing sent.',
    "Ce foyer n'a pas de thermostat : rien envoyé.",
  ),
  notSaved: both(
    '/data could not be written: nothing sent.',
    "/data n'a pas pu être écrit : rien envoyé.",
  ),
  notSent: (reason) => both(`Nothing sent (${reason}).`, `Rien envoyé (${reason}).`),
  refused: (reason) =>
    both(
      `Refused by the fireplace (${reason}): not applied.`,
      `Refusé par le foyer (${reason}) : non appliqué.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): read again shortly.`,
      `Envoyé, sans confirmation (${reason}) : relu sous peu.`,
    ),
  notApplied: both(
    'Sent, not applied yet (the read back shows the state before).',
    "Envoyé, pas encore appliqué (la relecture montre l'état d'avant).",
  ),
  sentDiffers: both(
    'Sent, the read back shows another value.',
    'Envoyé, la relecture montre une autre valeur.',
  ),
  noTimerOff: both(
    'Turned on, but the timer could not be set: the fireplace was turned off.',
    "Allumé, mais la minuterie n'a pas pu être posée : le foyer a été éteint.",
  ),
  noTimerSent: both(
    'Turned on, but the timer could not be set: turn off sent, without confirmation yet.',
    "Allumé, mais la minuterie n'a pas pu être posée : extinction envoyée, sans confirmation pour le moment.",
  ),
  noTimerKept: both(
    'Turned on, but the timer could not be set: the turn off has not left yet; it is kept and tried again.',
    "Allumé, mais la minuterie n'a pas pu être posée : l'extinction n'est pas encore partie ; elle est gardée et réessayée.",
  ),
  challengeRefused: both(
    'The fireplace answered 403 to every challenge (an expired challenge, or the key): nothing applied, try again.',
    "Le foyer a répondu 403 à chaque défi (défi expiré, ou la clé) : rien d'appliqué, réessayez.",
  ),
  setpointDiffers: both(
    'Setpoint sent, another value read back: the thermostat setpoint was set to 0.',
    'Consigne envoyée, une autre valeur relue : la consigne du thermostat a été remise à 0.',
  ),
  stopKeyRefused: both(
    'Turn off: nothing applied, the fireplace refuses the key or the user id; kept, it leaves as soon as a key is saved or a test read succeeds.',
    "Extinction : rien d'appliqué, le foyer refuse la clé ou l'identifiant ; gardée, elle part dès qu'une clé est enregistrée ou qu'une lecture de test réussit.",
  ),
  stopOtherSerial: both(
    'Turn off: another fireplace (another serial number) answers at the address: nothing posted; kept for this fireplace.',
    "Extinction : un autre foyer (autre numéro de série) répond à l'adresse : rien envoyé ; gardée pour ce foyer.",
  ),
  stopNotSent: (reason) =>
    both(
      `Turn off: nothing sent (${reason}); kept, tried again (every 15 s; spaced up to 1 h only after repeated 403s).`,
      `Extinction : rien envoyé (${reason}) ; gardée, réessayée (toutes les 15 s ; espacé jusqu'à 1 h seulement après des 403 répétés).`,
    ),
  stopWaitsKey: both(
    'Turn off: nothing sent (no valid key and user id configured); kept, it leaves as soon as they are saved.',
    "Extinction : rien envoyé (pas de clé et d'identifiant valides configurés) ; gardée, elle part dès qu'ils sont enregistrés.",
  ),
  stopUnconfirmed: both(
    'Turn off sent, without confirmation yet: checked every 15 s.',
    'Extinction envoyée, sans confirmation pour le moment : vérifiée toutes les 15 s.',
  ),
  stopPending: both(
    'Turn off on its way, not sent yet: it keeps going.',
    'Extinction en route, pas encore envoyée : elle continue.',
  ),
  stopNotApplied: both(
    'Turn off sent, the fireplace still shows the flame: sent again every 15 s (3 times at most).',
    'Extinction envoyée, le foyer montre encore la flamme : renvoyée toutes les 15 s (3 fois au plus).',
  ),
};
