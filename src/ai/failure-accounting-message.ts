/** Presentation only: immutable usage disposition determines the warning, never the failure status. */
export function aiFailureAccountingMessage(accounting:{usage:{disposition:string}|null}|null|undefined){
 switch(accounting?.usage?.disposition){
  case "UNCERTAIN":return "Accounting is uncertain; the protected reservation remains held pending an audited resolution.";
  case "SETTLED":return "Usage accounting is settled. The estimated cost is recorded and unused reservation capacity has been released.";
  // Never dispatched, or dispatched for input counting only: no generation request reached the provider.
  case "CANCELLED":return "The request never reached the AI model, so nothing was charged and its reservation was released.";
  default:return accounting?"Accounting has not been reconciled. Check its details before requesting another analysis.":"No reservation is recorded for this attempt.";
 }
}
