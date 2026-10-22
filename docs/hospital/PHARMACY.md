<!-- From AIVA OSHealth, adapted to the merged application. -->
# Pharmacy

Screen: Pharmacy & Inventory (pharmacist, administrator). API: `/api/v1/pharmacy`, `/api/v1/ward-medicine`.

## Items, batches and stock

A **medicine** (`drugs`) is an item: name, unit, reorder level, default MRP, GST %, HSN code (3004 for medicines). Its stock is held in **batches** (`drug_batches`): batch number, expiry, quantity, MRP, and the purchase price per unit (blank for stock entered before purchases were tracked). One batch number per medicine.

- Every change to a batch's quantity writes a line in the **stock ledger** (`stock_ledger`: opening, purchase, purchase cancelled, sale, dispense, sale cancelled, adjustment), with who and why. A quantity is never edited without one.
- **Selling takes from the batch that expires first** (FEFO), splitting across batches when needed, one sale line per batch at that batch's own MRP. An **expired batch is never sold** (expiry is measured in Indian time). A sale may name a particular batch.
- "In stock" everywhere means what can be sold (not expired). Expired units are counted apart, and are written off with an adjustment (reason required, never below zero).
- Stock valuation: at cost (where the purchase price is known; units with no known cost are counted separately) and at MRP.
- Existing databases: the old single batch / expiry / stock of each medicine becomes one batch, with an "opening" ledger line. Nothing is lost (tested).

## Purchases (suppliers' invoices)

A purchase records the supplier's invoice: their invoice number and date, and each line (medicine, batch, expiry, quantity, free quantity, purchase rate before GST, MRP, GST %). Receiving it puts the units (paid + free) into the batch (a new one, or more of an existing one, whose cost per unit becomes the average, free units costing nothing). Rules: the supplier's invoice number is entered once per supplier; an expired batch, a future-dated invoice, or a batch number already in stock with a different expiry is refused; a refused purchase leaves nothing behind. A line can name a medicine not yet in the list, which is added. A bill can be **imported from a spreadsheet (CSV)**: first row `medicine, batch, expiry, qty, rate, mrp` (optional `free, gst, unit`); expiry as `2027-03-31`, `31/03/2027` or `03/27`.

A payment can be recorded with the purchase or later (`amount_paid`; the dashboard shows what is owed to suppliers). A purchase can be cancelled (reason) only while all of its units are still on the shelf.

## Sales and invoices

- **Counter sale** (`PH-n`): a walk-in customer or a patient, any number of medicines, an optional discount % off the MRP, payment by cash / UPI / card / other (UPI and card need a reference, cash may record the amount handed over). Prices are the **MRP, which includes GST**: the line total is what is paid, and it splits into taxable value and tax. The invoice shows batch, expiry, HSN, GST by rate with CGST and SGST, the amount in words, the drug licence number and GSTIN (set under Masters > Hospital settings). A counter sale can be cancelled (reason); the stock goes back to its batches and the invoice stays, marked cancelled.
- **Dispense for a visit** (`DISP-n`): handing over a prescribed medicine takes stock the same way and is billed on the **visit's bill** (not invoiced separately). The pharmacist enters the quantity (the queue suggests it from frequency × duration, or from the ward schedule). A medicine not in the stock list can still be dispensed (nothing comes off stock) and is charged at the hospital's "unlisted medicine" price (an MRP). On a hospital bill a medicine line is entered at its taxable value so the bill's total comes back to the MRP.

## Reports

- **GST return figures (GSTR-1)** for a period: supplies to consumers by tax rate, the HSN summary, credit notes and the documents issued (invoice number range, count, cancelled), all treated as within the state (CGST = SGST). An invoice issued in the period and still valid at its end counts in it; an invoice of an earlier period that was cancelled in this one is listed as a **credit note** and subtracted; one issued and cancelled inside the same period nets to nothing. Counter sales and dispenses for visits are both included. The tax paid on purchases in the period is shown for reference. Download as CSV. **These are preparation figures: have your accountant check them before filing.**
- **Profit & loss**: sales (before GST) by kind, the cost of what was sold (purchase price × quantity, from the batch sold), gross profit and margin, purchases in the period, and profit by medicine. Sales of stock with no purchase price are shown and **left out of the profit**, so a missing cost never inflates it.
- **Dashboard**: today's counter sales and dispenses, prescriptions waiting, stock value, owed to suppliers, medicines below their reorder level, expired and expiring units, fast-moving medicines (30 days), the last seven days' sales.

## The ward medicine schedule

For an admitted patient, a prescribed medicine can be **scheduled**: times of the day (the usual times for OD, BD, TDS, QID, HS, or chosen), optionally for a number of days. Doses are created as their day comes (today and tomorrow), never for a time already past when the schedule was made, and never after discharge. The **Medicine Round** screen lists doses due in the next few hours across the ward (overdue ones highlighted); each is marked **given**, **missed** or **held** (the last two need a reason) with who and when, and all of it is audited. Stopping a schedule removes doses not yet due. The pharmacy's queue shows that a prescription is on the ward schedule and suggests the quantity the course needs. Giving a dose (the nurse's record) is separate from dispensing (the pharmacy's stock and billing).

## Who can do what

| | |
|---|---|
| See what is in stock | pharmacist, doctor, nurse, admin |
| Items, suppliers, purchases, sales, stock adjustments, dispensing, reports | pharmacist, admin |
| Schedule and give doses (Medicine Round) | nurse, doctor, admin |
