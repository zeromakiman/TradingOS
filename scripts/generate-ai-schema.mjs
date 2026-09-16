import { writeFileSync } from 'node:fs';
const text = { type: 'string', minLength: 1 };
const en = (...values) => ({ type: 'string', enum: values });
const arr = items => ({ type: 'array', items });
const nullable = value => ({ anyOf: [value, { type: 'null' }] });
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const ref = name => ({ $ref: '#/$defs/' + name });
const ids = arr(text);
const confidence = en('HIGH','MEDIUM','LOW','UNKNOWN');
const timeframe = en('D1','H4','H1','M30','M15','M5','M3','UNKNOWN');
const quality = en('STRONG','ADEQUATE','WEAK','AMBIGUOUS','UNKNOWN');
const assessment = obj({ status: en('SUPPORTED','REFUTED','AMBIGUOUS','NOT_ASSESSED','NOT_APPLICABLE'), confidence, evidence_ids: ids, rule_ids: ids, rationale: text });
const issue = obj({ id: text, code: en('MISSING_CHART','UNREADABLE_CHART','MISSING_TIMEFRAME','UNVERIFIED_TIME','UNVERIFIED_PRICE','UNVERIFIED_FIRST_TOUCH','AMBIGUOUS_MSS','AMBIGUOUS_DISPLACEMENT','AMBIGUOUS_LIQUIDITY','AMBIGUOUS_OB_ZONE','MISSING_OTE_PARAMETERS','MISSING_TARGET_CONTEXT','MISSING_NEWS_CONTEXT','MISSING_STRATEGY_PARAMETER','SOURCE_CONFLICT','STRATEGY_CONTRADICTION','UNRECOGNIZED_MODEL','OTHER_EVIDENCE_GAP'), description: text, material_to_decision: { type: 'boolean' }, evidence_ids: ids, rule_ids: ids });
const liquidity = obj({ liquidity_type: en('ARL_HIGH','ARL_LOW','PDH','PDL','PWH','PWL','KILL_ZONE_HIGH','KILL_ZONE_LOW','EQUAL_HIGHS','EQUAL_LOWS','PRIOR_SWING_HIGH','PRIOR_SWING_LOW','PREVIOUS_DAY_50_PERCENT','STRUCTURAL_LIQUIDITY','UNKNOWN'), internal_or_external: en('INTERNAL','EXTERNAL','UNKNOWN'), reported_price: nullable({type:'string',pattern:'^[0-9]+(\\.[0-9]+)?$'}), evidence_ids: ids, assessment: ref('assessment') });
const schema = { ...obj({
 schema_version: en('1.0'), analysis_id: text, input_hash: {type:'string',pattern:'^[0-9a-f]{64}$'}, strategy_version: text, risk_plan_version: text, instrument: text,
 evaluator_role: en('A','B','RECONCILER'), direction: en('LONG','SHORT','UNKNOWN'), setup_model: en('OB_FIRST_TOUCH','OTE','UNRECOGNIZED','UNKNOWN'),
 htf_context: obj({daily:ref('assessment'),h4:ref('assessment'),h1:ref('assessment'),alignment:en('ALIGNED','MIXED','OPPOSED','UNKNOWN')}),
 liquidity_events: arr(obj({event:en('SWEPT','TARGETED','UNCONFIRMED'),liquidity:ref('liquidity'),timeframe})), liquidity_target: nullable(ref('liquidity')),
 mss: ref('assessment'), mss_timeframe: timeframe, mss_quality: quality, displacement: ref('assessment'), displacement_quality: quality,
 order_block: obj({validity:ref('assessment'),timeframe,originating_candle:en('BULLISH','BEARISH','UNKNOWN'),zone_construction:ref('assessment'),first_touch:ref('assessment'),proximal_edge_entry:ref('assessment')}),
 ote: obj({validity:ref('assessment'),rationale:en('EXTENDED_DISPLACEMENT','OB_TOO_DISTANT','OB_INEFFICIENT','PREDEFINED_BETTER_LOCATION','UNKNOWN','NOT_APPLICABLE'),anchor_definition:ref('assessment'),versioned_parameters_available:en('YES','NO','UNKNOWN')}),
 entry_valid:ref('assessment'),target_valid:ref('assessment'),
 observed_evidence:arr(obj({id:text,source_id:text,source_type:en('CHART_IMAGE','MARKET_DATA'),locator:text,statement:text,confidence})),
 user_reported_evidence:arr(obj({id:text,source_id:text,locator:text,statement:text})),
 inferred_evidence:arr(obj({id:text,premise_evidence_ids:{...ids,minItems:1},statement:text,confidence})),
 missing_evidence:arr(ref('issue')),uncertainties:arr(ref('issue')),contradictions:arr(ref('issue')),rule_violations:arr(obj({id:text,rule_id:text,evidence_ids:{...ids,minItems:1},rationale:text})),warnings:arr(ref('issue')),
 grade_components:arr(obj({component:en('HTF_ALIGNMENT','LIQUIDITY_CONTEXT','MSS_QUALITY','DISPLACEMENT_QUALITY','ENTRY_MODEL_VALIDITY','TARGET_QUALITY','EVIDENCE_CLARITY'),rating:en('STRONG','ADEQUATE','WEAK','INVALID','UNKNOWN','NOT_APPLICABLE'),assessment:ref('assessment')})),
 qualitative_decision:en('APPROVED','CONDITIONAL','BLOCKED'),decision_reason:obj({code:en('SUPPORTED_BY_AVAILABLE_EVIDENCE','MATERIAL_EVIDENCE_MISSING','MATERIAL_UNCERTAINTY','UNRESOLVED_CONTRADICTION','STRATEGY_VIOLATION','UNRECOGNIZED_MODEL'),summary:text,evidence_ids:ids,rule_ids:ids}),
 reconciliation:obj({reviewed_analysis_ids:ids,accepted_finding_ids:ids,rejected_finding_ids:ids,unresolved_finding_ids:ids,summary:text})
 }), $defs:{assessment,issue,liquidity} };
writeFileSync(new URL('../src/ai/evaluation.schema.json',import.meta.url),JSON.stringify(schema,null,2)+'\n');
