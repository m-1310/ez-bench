'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.BenchSqlText=factory();})(typeof globalThis==='object'?globalThis:this,function(){
  const KEYWORDS='SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER ASC DESC LIMIT OFFSET TOP AS AND OR NOT NULL IS IN LIKE BETWEEN HAVING DISTINCT CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE VIEW INDEX ALTER DROP PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK BEGIN COMMIT ROLLBACK WITH UNION ALL EXISTS RETURNING USE SHOW DATABASES EXPLAIN PRAGMA COUNT SUM AVG MIN MAX COALESCE CAST'.split(' ');
  function statementRanges(sql,dialect='mysql'){
    const ranges=[];let start=0,quote=null,dollar=null,comment=null,depth=0,escape=false,hasCode=false;
    for(let i=0;i<sql.length;i++){
      const c=sql[i],next=sql[i+1];
      if(dollar){if(sql.startsWith(dollar,i)){i+=dollar.length-1;dollar=null;}continue;}
      if(comment==='line'){if(c==='\n')comment=null;continue;}
      if(comment==='block'){if((dialect==='postgres'||dialect==='mssql')&&c==='/'&&next==='*'){depth++;i++;}else if(c==='*'&&next==='/'){if(!--depth)comment=null;i++;}continue;}
      if(quote){const closing=quote==='['?']':quote;if(c===closing){if(next===closing)i++;else quote=null;}else if((dialect==='mysql'||escape)&&c==='\\'&&next)i++;continue;}
      if(c==='-'&&next==='-'&&(dialect!=='mysql'||/\s|$/.test(sql[i+2]||''))||c==='#'&&dialect==='mysql'){comment='line';if(c==='-')i++;continue;}
      if(c==='/'&&next==='*'){comment='block';depth=1;i++;continue;}
      if(dialect==='postgres'&&c==='$'){const marker=sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];if(marker){dollar=marker;i+=marker.length-1;hasCode=true;continue;}}
      if(c===';' ){if(hasCode)ranges.push({start,end:i+1,sql:sql.slice(start,i+1)});start=i+1;hasCode=false;continue;}
      if(c==="'"||c==='"'||c==='`'||c==='['&&(dialect==='mssql'||dialect==='sqlite')){quote=c;escape=dialect==='postgres'&&c==="'"&&/[eE]/.test(sql[i-1]||'')&&!/[A-Za-z_0-9]/.test(sql[i-2]||'');}
      if(!/\s/.test(c))hasCode=true;
    }
    if(hasCode)ranges.push({start,end:sql.length,sql:sql.slice(start)});return ranges;
  }
  function statementAt(sql,cursor,dialect){const ranges=statementRanges(sql,dialect);const position=Math.min(Math.max(0,Number(cursor)||0),sql.length);return ranges.find(range=>position>=range.start&&position<=range.end)||ranges.find(range=>range.start>position)||ranges.at(-1)||null;}
  return{KEYWORDS,statementRanges,statementAt};
});
