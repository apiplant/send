/**
 * The PGP Word List — 512 words picked to be phonetically distinct, so a code
 * survives being read aloud over a bad line. It is the vocabulary magic-wormhole
 * uses, and codes alternate the two halves so a dropped word is detectable.
 *
 * The words are chosen *here*, in the browser, and never sent to the signalling
 * server: they are the shared secret SPAKE2 authenticates the transfer with. The
 * server only ever learns the leading nameplate number.
 */

/** The three-syllable half; a code's first word comes from here. */
export const ODD_WORDS = [
  "adroitness", "adviser", "aftermath", "aggregate", "alkali", "almighty", "amulet",
  "amusement", "antenna", "applicant", "apollo", "armistice", "article", "asteroid", "atlantic",
  "atmosphere", "autopsy", "babylon", "backwater", "barbecue", "belowground", "bifocals",
  "bodyguard", "bookseller", "borderline", "bottomless", "bradbury", "bravado", "brazilian",
  "breakaway", "burlington", "businessman", "butterfat", "camelot", "candidate", "cannonball",
  "capricorn", "caravan", "caretaker", "celebrate", "cellulose", "certify", "chambermaid",
  "cherokee", "chicago", "clergyman", "coherence", "combustion", "commando", "company",
  "component", "concurrent", "confidence", "conformist", "congregate", "consensus",
  "consulting", "corporate", "corrosion", "councilman", "crossover", "crucifix", "cumbersome",
  "customer", "dakota", "decadence", "december", "decimal", "designing", "detector",
  "detergent", "determine", "dictator", "dinosaur", "direction", "disable", "disbelief",
  "disruptive", "distortion", "document", "embezzle", "enchanting", "enrollment", "enterprise",
  "equation", "equipment", "escapade", "eskimo", "everyday", "examine", "existence", "exodus",
  "fascinate", "filament", "finicky", "forever", "fortitude", "frequency", "gadgetry",
  "galveston", "getaway", "glossary", "gossamer", "graduate", "gravity", "guitarist",
  "hamburger", "hamilton", "handiwork", "hazardous", "headwaters", "hemisphere", "hesitate",
  "hideaway", "holiness", "hurricane", "hydraulic", "impartial", "impetus", "inception",
  "indigo", "inertia", "infancy", "inferno", "informant", "insincere", "insurgent", "integrate",
  "intention", "inventive", "istanbul", "jamaica", "jupiter", "leprosy", "letterhead",
  "liberty", "maritime", "matchmaker", "maverick", "medusa", "megaton", "microscope",
  "microwave", "midsummer", "millionaire", "miracle", "misnomer", "molasses", "molecule",
  "montana", "monument", "mosquito", "narrative", "nebula", "newsletter", "norwegian",
  "october", "ohio", "onlooker", "opulent", "orlando", "outfielder", "pacific", "pandemic",
  "pandora", "paperweight", "paragon", "paragraph", "paramount", "passenger", "pedigree",
  "pegasus", "penetrate", "perceptive", "performance", "pharmacy", "phonetic", "photograph",
  "pioneer", "pocketful", "politeness", "positive", "potato", "processor", "provincial",
  "proximate", "puberty", "publisher", "pyramid", "quantity", "racketeer", "rebellion",
  "recipe", "recover", "repellent", "replica", "reproduce", "resistor", "responsive",
  "retraction", "retrieval", "retrospect", "revenue", "revival", "revolver", "sandalwood",
  "sardonic", "saturday", "savagery", "scavenger", "sensation", "sociable", "souvenir",
  "specialist", "speculate", "stethoscope", "stupendous", "supportive", "surrender",
  "suspicious", "sympathy", "tambourine", "telephone", "therapist", "tobacco", "tolerance",
  "tomorrow", "torpedo", "tradition", "travesty", "trombonist", "truncated", "typewriter",
  "ultimate", "undaunted", "underfoot", "unicorn", "unify", "universe", "unravel", "upcoming",
  "vacancy", "vagabond", "vertigo", "virginia", "visitor", "vocalist", "voyager", "warranty",
  "waterloo", "whimsical", "wichita", "wilmington", "wyoming", "yesteryear", "yucatan"
] as const;

/** The two-syllable half. */
export const EVEN_WORDS = [
  "aardvark", "absurd", "accrue", "acme", "adrift", "adult", "afflict", "ahead", "aimless",
  "algol", "allow", "alone", "ammo", "ancient", "apple", "artist", "assume", "athens", "atlas",
  "aztec", "baboon", "backfield", "backward", "banjo", "beaming", "bedlamp", "beehive",
  "beeswax", "befriend", "belfast", "berserk", "billiard", "bison", "blackjack", "blockade",
  "blowtorch", "bluebird", "bombast", "bookshelf", "brackish", "breadline", "breakup",
  "brickyard", "briefcase", "burbank", "button", "buzzard", "cement", "chairlift", "chatter",
  "checkup", "chisel", "choking", "chopper", "christmas", "clamshell", "classic", "classroom",
  "cleanup", "clockwork", "cobra", "commence", "concert", "cowbell", "crackdown", "cranky",
  "crowfoot", "crucial", "crumpled", "crusade", "cubic", "dashboard", "deadbolt", "deckhand",
  "dogsled", "dragnet", "drainage", "dreadful", "drifter", "dropper", "drumbeat", "drunken",
  "dupont", "dwelling", "eating", "edict", "egghead", "eightball", "endorse", "endow", "enlist",
  "erase", "escape", "exceed", "eyeglass", "eyetooth", "facial", "fallout", "flagpole",
  "flatfoot", "flytrap", "fracture", "framework", "freedom", "frighten", "gazelle", "geiger",
  "glitter", "glucose", "goggles", "goldfish", "gremlin", "guidance", "hamlet", "highchair",
  "hockey", "indoors", "indulge", "inverse", "involve", "island", "jawbone", "keyboard",
  "kickoff", "kiwi", "klaxon", "locale", "lockup", "merit", "minnow", "miser", "mohawk",
  "mural", "music", "necklace", "neptune", "newborn", "nightbird", "oakland", "obtuse",
  "offload", "optic", "orca", "payday", "peachy", "pheasant", "physique", "playhouse", "pluto",
  "preclude", "prefer", "preshrunk", "printer", "prowler", "pupil", "puppy", "python",
  "quadrant", "quiver", "quota", "ragtime", "ratchet", "rebirth", "reform", "regain",
  "reindeer", "rematch", "repay", "retouch", "revenge", "reward", "rhythm", "ribcage",
  "ringbolt", "robust", "rocker", "ruffled", "sailboat", "sawdust", "scallion", "scenic",
  "scorecard", "scotland", "seabird", "select", "sentence", "shadow", "shamrock", "showgirl",
  "skullcap", "skydive", "slingshot", "slowdown", "snapline", "snapshot", "snowcap",
  "snowslide", "solo", "southward", "soybean", "spaniel", "spearhead", "spellbind", "spheroid",
  "spigot", "spindle", "spyglass", "stagehand", "stagnate", "stairway", "standard", "stapler",
  "steamship", "sterling", "stockman", "stopwatch", "stormy", "sugar", "surmount", "suspense",
  "sweatband", "swelter", "tactics", "talon", "tapeworm", "tempest", "tiger", "tissue", "tonic",
  "topmost", "tracker", "transit", "trauma", "treadmill", "trojan", "trouble", "tumor",
  "tunnel", "tycoon", "uncut", "unearth", "unwind", "uproot", "upset", "upshot", "vapor",
  "village", "virus", "vulcan", "waffle", "wallet", "watchword", "wayside", "willow",
  "woodlark", "zulu"
] as const;

/** `<nameplate>-<odd word>-<even word>`, e.g. `4-unicorn-waffle`. */
export function pickWords(): string {
  const random = crypto.getRandomValues(new Uint8Array(2));
  return `${ODD_WORDS[random[0]]}-${EVEN_WORDS[random[1]]}`;
}

export interface ParsedCode {
  /** The part the server allocated and knows. */
  nameplate: string;
  /** The part only the two devices know — the SPAKE2 password. */
  words: string;
}

/**
 * Accepts what a person might actually type: extra spaces, capitals, or
 * underscores where the dashes should be.
 */
export function parseCode(input: string): ParsedCode | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const match = /^([0-9]+)-([a-z]+-[a-z]+)$/.exec(normalized);
  return match ? { nameplate: match[1], words: match[2] } : null;
}

export function formatCode(nameplate: string, words: string): string {
  return `${nameplate}-${words}`;
}
