// The "check everything yourself" disclaimers every return the app prepares carries (CLAUDE.md,
// "Invariants"): Self Assessment for you, and a company's VAT return and Corporation Tax return. Shared by the server (its CSV
// exports, its responses) and the web app (`components/CheckEverything.tsx`).

/** The heading the disclaimer is shown under. */
export const CHECK_EVERYTHING_TITLE = 'You must check everything before you submit';

export const SA_DISCLAIMER =
  'This page gathers figures from your own data to help you fill in your Self Assessment return. It is not tax advice and it can be incomplete or wrong: bank data shows net pay, may miss interest paid into accounts you have not imported, and cannot know which donations were Gift Aided. Check every figure against your P60, P11D, bank interest statements, pension and dividend statements before you submit. You are responsible for your return.';

export const VAT_RETURN_DISCLAIMER =
  'These boxes are worked out from the company’s books to help you prepare its VAT return. They are not tax advice and can be incomplete or wrong: they are only as good as the coding of every payment, and only the cash accounting scheme is covered. Nothing here is sent to HMRC. Check every box against the company’s records, invoices and bank statements before you submit it through your Making Tax Digital software. The company is responsible for its return.';

export const CT_DISCLAIMER =
  'This computation and these CT600 boxes are worked out from the company’s books to help you prepare its Company Tax Return. They are not tax advice and can be incomplete or wrong: they are only as good as the coding of every payment, they make the default choices described (claims the company may make differently), and much of Corporation Tax is not covered here (cars, intangible assets, chargeable gains, group relief, s455 tax on loans to participators, qualifying donations, R&D and other reliefs). Nothing here is sent to HMRC. Check every figure against the company’s accounts and records, and the computation your filing software or accountant produces, before you submit. The company is responsible for its return.';
