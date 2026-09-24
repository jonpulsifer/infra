data "google_billing_account" "cloudlab" {
  display_name = "Cloudlab Billing Account"
  open         = true
}

# With no notifications rule, the API emails the billing-account admins.
locals {
  budgets = {
    "5-bones"  = { display_name = "5 bones", units = "5" }
    "20-bones" = { display_name = "20 bones", units = "20" }
    "30-bones" = { display_name = "30 bones", units = "30" }
  }
}

resource "google_billing_budget" "bones" {
  for_each        = local.budgets
  billing_account = data.google_billing_account.cloudlab.id
  display_name    = each.value.display_name

  amount {
    specified_amount {
      currency_code = "USD"
      units         = each.value.units
    }
  }

  budget_filter {
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }
}

import {
  to = google_billing_budget.bones["5-bones"]
  id = "billingAccounts/009BE0-2F835F-F20651/budgets/eb4071bd-13b5-4c7e-96d6-668e69625576"
}

import {
  to = google_billing_budget.bones["20-bones"]
  id = "billingAccounts/009BE0-2F835F-F20651/budgets/90ff5fb0-800a-42ee-8b0d-e57ff2800256"
}

import {
  to = google_billing_budget.bones["30-bones"]
  id = "billingAccounts/009BE0-2F835F-F20651/budgets/TAIM6DJYVYQYSP6CRQGOISSNHM000000"
}
