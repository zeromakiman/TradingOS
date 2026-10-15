/** Presentation only: immutable usage disposition determines the warning, never the failure status. */
export function aiFailureAccountingMessage(accounting:{usage:{disposition:string}|null}|null|undefined){
 switch(accounting?.usage?.disposition){
  case "UNCERTAIN":return "Accounting is uncertain; the protected reservation remains held pending an audited resolution.";
  case "SETTLED":return "Usage accounting is settled. The estimated cost is recorded and unused reservation capacity has been released.";
  case "CANCELLED":return "The request was cancelled before dispatch and its reservation was released.";
  default:return accounting?"Accounting has not been reconciled. Check its details before requesting another analysis.":"No reservation is recorded for this attempt.";
 }
}
