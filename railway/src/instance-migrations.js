// Historical imports in the original repository belong to its original store.
// A fresh WB3 instance needs their schema, never their business records.
const ORIGINAL_STORE_DATA=new Set(['006_kaspi_ads_20260810_16.sql','007_verify_kaspi_ads_20260810_16.sql','008_kaspi_ads_20260817_23.sql','009_kaspi_ads_20260803_09.sql','018_wb1_verified_campaign_names.sql']);
export function instanceMigrationSql(file,sql,profile=''){
 if(profile!=='WB3')return sql;
 if(ORIGINAL_STORE_DATA.has(file))return 'SELECT 1; -- Original store data intentionally excluded';
 if(file==='011_wb_ad_name_overrides.sql')return sql.slice(0,sql.indexOf('INSERT INTO wb_ad_name_overrides'));
 return sql;
}
