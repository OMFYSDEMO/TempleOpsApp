# Marketing scorecard and campaign tagging

The scorecard (Revenue → Marketing scorecard; revenue, owner and accountant) measures the agency's work from
the books: leads by source and month, how many sales answered within the hour, how many became bookings,
the room-nights and gross revenue of those bookings, and the marketing spend from the expense book. From
those it shows cost per lead, cost per booking and rupees of revenue per rupee spent.

Revenue counts only bookings that came from a lead. OTA bookings have no lead and are on Revenue overview
instead. Spend is every expense in the category "Marketing & advertising", petty or bank.

## Where the campaign tag comes from

| Lead source | Campaign on the lead | What the agency or vendor must do |
|---|---|---|
| Website form | `utm_campaign` (or `campaign`), plus `utm_source`, `utm_medium`, `utm_content` as the ad | The site keeps the UTM values from the landing URL and sends them with the enquiry form (see docs/deploy-cloudflare.md, step "Website form") |
| Instagram / Facebook lead ads | Meta's `campaign_name` and `ad_name`, fetched with the lead | Name campaigns consistently in Ads Manager; nothing else |
| WhatsApp, phone, walk-in | Typed by sales in the "Campaign" box on the new-lead form | Sales asks "where did you see us?" and types the same name |

Spend gets its tag from the "Campaign" box that appears on an expense when the category is marketing (Bank
expenses for the owner, the petty-cash capture for the property desk). Use exactly the campaign name the
agency uses on the ads, otherwise the scorecard shows the lead side and the spend side as two rows.

"(no campaign)" on the scorecard means the tag was missing on that side. A campaign row with leads but no
spend is a campaign the agency ran that was not billed under that name; spend with no leads is a bill with
no tagged leads yet.

## Ask the agency for

1. A campaign naming convention shared with you in writing, used identically on Meta, Google and invoices.
2. UTM parameters on every link they place: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`.
3. Invoices itemised by campaign, so each line can be entered as a separate marketing expense with its tag.
