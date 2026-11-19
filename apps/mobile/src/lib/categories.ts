/**
 * Expense categories: ten fixed ones, the foundation for spending by category. A category is
 * suggested from the description on the phone (keyword matching, nothing is sent anywhere) and
 * can always be changed. Expenses saved before categories existed show a guessed one; it's only
 * saved when someone edits the expense. Keep the ids in step with the expense_categories migration.
 */
export const CATEGORIES = [
  { id: 'food', emoji: '🍽️', name: 'Food & drink' },
  { id: 'groceries', emoji: '🛒', name: 'Groceries' },
  { id: 'accommodation', emoji: '🏨', name: 'Accommodation' },
  { id: 'transport', emoji: '🚗', name: 'Transport' },
  { id: 'home', emoji: '🏠', name: 'Rent & home' },
  { id: 'bills', emoji: '💡', name: 'Bills & utilities' },
  { id: 'entertainment', emoji: '🎟️', name: 'Entertainment' },
  { id: 'shopping', emoji: '🛍️', name: 'Shopping' },
  { id: 'health', emoji: '💊', name: 'Health & personal' },
  { id: 'other', emoji: '📦', name: 'Other' },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];
export type Category = (typeof CATEGORIES)[number];

export function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && CATEGORIES.some((c) => c.id === value);
}

export function categoryById(id: CategoryId): Category {
  return CATEGORIES.find((c) => c.id === id)!;
}

// First match wins, so more specific words come before general ones ("uber eats" before "uber",
// "barber" before "bar").
const RULES: [RegExp, CategoryId][] = [
  [/\b(uber eats|menulog|doordash|deliveroo)/, 'food'],
  [/\b(pharmacy|chemist|doctor|gp|dentist|physio|medicine|hospital|haircut|hairdresser|barber|salon|nails|massage|gym|fitness|yoga|sunscreen|toiletries)/, 'health'],
  [/\b(grocer|supermarket|woolies|woolworths|coles|aldi|iga|costco|market|fruit|veg|milk|bread)/, 'groceries'],
  [/\b(rent|bond|furniture|ikea|bunnings|cleaning|cleaner|repair|plumber|electrician|household|kitchen|bedding|lawn|garden)/, 'home'],
  [/\b(electric|power|energy|gas bill|water bill|water|internet|wifi|wi-fi|nbn|phone|mobile|netflix|spotify|stan|disney|subscription|council|rates|insurance|bill)/, 'bills'],
  [/\b(hotel|motel|hostel|airbnb|villa|accommodation|lodge|resort|camping|campsite|cabin|booking\.com|stay)/, 'accommodation'],
  [/\b(petrol|fuel|uber|didi|ola|taxi|cab|car hire|rental car|parking|toll|flight|plane|airport|airline|qantas|jetstar|virgin|train|bus|metro|tram|ferry|scooter|bike|transport|opal|myki|go card|rego|car)/, 'transport'],
  [/\b(pizza|burger|sushi|ramen|coffee|cafe|café|beer|pub|bar|drinks?|wine|cocktail|dinner|lunch|breakfast|brunch|restaurant|meal|food|takeaway|take-away|uber eats|menulog|doordash|kebab|dumpling|thai|chinese|indian|pho|tacos?|bbq|dessert|ice ?cream|cake|bakery|snacks?|pasta|noodle|curry|steak|seafood|fish|sandwich|salad|burrito|yum cha|gelato|donut|pie|chicken|parma|tapas)/, 'food'],
  [/\b(movie|cinema|film|ticket|concert|gig|show|festival|museum|gallery|tour|zoo|park entry|theme park|bowling|golf|karaoke|escape room|game|party|club|event|activity|activities|surf lesson|lesson)/, 'entertainment'],
  [/\b(gift|present|birthday|clothes|clothing|shoes|shop|shopping|kmart|target|big w|amazon|souvenir|book)/, 'shopping'],
];

/** The category a description suggests, or Other when nothing matches. */
export function guessCategory(description: string): CategoryId {
  const text = description.toLowerCase();
  return RULES.find(([re]) => re.test(text))?.[1] ?? 'other';
}

/** An expense's category: the saved one, or a guess for expenses saved before categories. */
export function categoryOf(expense: { category: CategoryId | null; description: string }): CategoryId {
  return expense.category ?? guessCategory(expense.description);
}
