import type postgres from "postgres";
import { runSql } from "../../sql/exec.ts";

/**
 * Create the schema-local tree routines: `move_tree`, `copy_tree`,
 * `delete_tree`, three `count_tree` overloads (ltree / lquery / ltxtquery), and
 * `list_tree`. All bodies are part of the immutable schema format; ltree
 * objects are qualified with a literal `public`.
 */
export async function createTreeRoutines(
  tx: postgres.TransactionSql,
  indexSchema: string,
): Promise<void> {
  // ------------------------------------------------------------------------
  // move_tree
  // ------------------------------------------------------------------------
  // Rewrite the ltree prefix of every record at or under `_src` to `_dst`,
  // preserving id/name/content/meta/temporal/embedding. record_integrity fires
  // per row (tree changed → version/hash advance; content/embedding unchanged →
  // no re-embed). Unlike ME's snapshot-then-update, this is a SINGLE UPDATE
  // whose WHERE is re-checked by PostgreSQL against the live row (EvalPlanQual):
  // a row a concurrent writer moved out from under `_src` between planning and
  // execution is no longer matched and is not mis-rewritten, and the RETURNING
  // count reflects rows actually updated, not a stale snapshot. A destination
  // (tree, name) collision raises 23505 and rolls the whole statement back.
  await runSql(
    tx`
      create function ${tx(indexSchema)}.move_tree
      ( _src public.ltree
      , _dst public.ltree
      , _dry_run boolean default false
      )
      returns bigint
      language plpgsql volatile security invoker
      set search_path to pg_catalog, public, pg_temp
      as $function$
      declare
        _n bigint;
      begin
        if _dry_run then
          select count(*) into _n
          from ${tx(indexSchema)}.record m
          where _src operator(public.@>) m.tree;
          return _n;
        end if;

        with moved as
        (
          update ${tx(indexSchema)}.record m
          set tree = case
            when public.nlevel(m.tree) = public.nlevel(_src) then _dst
            else _dst operator(public.||) public.subpath(m.tree, public.nlevel(_src), public.nlevel(m.tree) - public.nlevel(_src))
          end
          where _src operator(public.@>) m.tree
          returning m.id
        )
        select count(*) into _n from moved;
        return _n;
      end
      $function$
    `,
    {
      spanName: "createMoveTreeFunction",
      dbOperationName: "CREATE",
      namespace: indexSchema,
    },
  );

  // ------------------------------------------------------------------------
  // copy_tree
  // ------------------------------------------------------------------------
  // Insert a fresh record for each source-subtree row under `_dst`. New rows get
  // a generated UUIDv7 and content_version/version reset to 1 by the insert
  // trigger; a copied non-null embedding is preserved (no re-embed), a null one
  // enqueues normally. The source is untouched; a destination (tree, name)
  // collision raises 23505 and rolls back.
  await runSql(
    tx`
      create function ${tx(indexSchema)}.copy_tree
      ( _src public.ltree
      , _dst public.ltree
      , _dry_run boolean default false
      )
      returns bigint
      language plpgsql volatile security invoker
      set search_path to pg_catalog, public, pg_temp
      as $function$
      declare
        _n bigint;
      begin
        if _dry_run then
          select count(*) into _n
          from ${tx(indexSchema)}.record m
          where _src operator(public.@>) m.tree;
          return _n;
        end if;

        with copied as
        (
          insert into ${tx(indexSchema)}.record
            (content, meta, tree, temporal, name, embedding)
          select
            m.content
          , m.meta
          , case
              when public.nlevel(m.tree) = public.nlevel(_src) then _dst
              else _dst operator(public.||) public.subpath(m.tree, public.nlevel(_src), public.nlevel(m.tree) - public.nlevel(_src))
            end
          , m.temporal
          , m.name
          , m.embedding
          from ${tx(indexSchema)}.record m
          where _src operator(public.@>) m.tree
          returning id
        )
        select count(*) into _n from copied;
        return _n;
      end
      $function$
    `,
    {
      spanName: "createCopyTreeFunction",
      dbOperationName: "CREATE",
      namespace: indexSchema,
    },
  );

  // ------------------------------------------------------------------------
  // delete_tree
  // ------------------------------------------------------------------------
  // Delete the inclusive subtree; queue rows cascade via the FK. Returns the
  // count (dry-run counts without deleting).
  await runSql(
    tx`
      create function ${tx(indexSchema)}.delete_tree
      ( _tree public.ltree
      , _dry_run boolean default false
      )
      returns bigint
      language plpgsql volatile security invoker
      set search_path to pg_catalog, public, pg_temp
      as $function$
      declare
        _n bigint;
      begin
        if _dry_run then
          select count(*) into _n
          from ${tx(indexSchema)}.record m
          where _tree operator(public.@>) m.tree;
          return _n;
        end if;

        with deleted as
        (
          delete from ${tx(indexSchema)}.record m
          where _tree operator(public.@>) m.tree
          returning m.id
        )
        select count(*) into _n from deleted;
        return _n;
      end
      $function$
    `,
    {
      spanName: "createDeleteTreeFunction",
      dbOperationName: "CREATE",
      namespace: indexSchema,
    },
  );

  // ------------------------------------------------------------------------
  // count_tree (three explicit filter kinds)
  // ------------------------------------------------------------------------
  // `_max_count` bounds the scan; the TS layer passes max+1 so it can tell an
  // exact count from a capped one. `limit null` means no cap. These SQL `stable`
  // routines omit `set search_path` (a SET clause records proconfig, which
  // — though these are not inlineable, having a relation scan/subquery/aggregate
  // — needlessly costs a per-call GUC save/restore); every reference is fully
  // qualified so they are correct under any caller path.
  await runSql(
    tx`
      create function ${tx(indexSchema)}.count_tree(_tree public.ltree, _max_count bigint default null)
      returns bigint
      language sql stable security invoker
      as $function$
        select pg_catalog.count(*) from
        (
          select 1 from ${tx(indexSchema)}.record m
          where _tree operator(public.@>) m.tree
          limit _max_count
        ) t
      $function$
    `,
    {
      spanName: "createCountTreeLtreeFunction",
      dbOperationName: "CREATE",
      namespace: indexSchema,
    },
  );
  await runSql(
    tx`
      create function ${tx(indexSchema)}.count_tree(_query public.lquery, _max_count bigint default null)
      returns bigint
      language sql stable security invoker
      as $function$
        select pg_catalog.count(*) from
        (
          select 1 from ${tx(indexSchema)}.record m
          where m.tree operator(public.~) _query
          limit _max_count
        ) t
      $function$
    `,
    {
      spanName: "createCountTreeLqueryFunction",
      dbOperationName: "CREATE",
      namespace: indexSchema,
    },
  );
  await runSql(
    tx`
      create function ${tx(indexSchema)}.count_tree(_query public.ltxtquery, _max_count bigint default null)
      returns bigint
      language sql stable security invoker
      as $function$
        select pg_catalog.count(*) from
        (
          select 1 from ${tx(indexSchema)}.record m
          where m.tree operator(public.@) _query
          limit _max_count
        ) t
      $function$
    `,
    {
      spanName: "createCountTreeLtxtqueryFunction",
      dbOperationName: "CREATE",
      namespace: indexSchema,
    },
  );

  // ------------------------------------------------------------------------
  // list_tree
  // ------------------------------------------------------------------------
  // For every record matching `_query`, emit each of its non-root ancestor
  // prefixes and count how many records fall under each. A matching record thus
  // contributes to every ancestor node, so counts are descendant totals, not
  // immediate-child counts. Ordered by tree for a stable listing.
  //
  // SQL `stable`, single-`SELECT`, `security invoker`, and — like the record
  // reads — it omits `set search_path` so PostgreSQL can inline it. Everything
  // is fully qualified (table by schema, ltree ops/functions by `public`,
  // aggregate and set function by `pg_catalog`) to stay correct under any path.
  await runSql(
    tx`
      create function ${tx(indexSchema)}.list_tree(_query public.lquery)
      returns table (tree public.ltree, count bigint)
      language sql stable security invoker
      as $function$
        with matched as
        (
          select distinct m.id, m.tree
          from ${tx(indexSchema)}.record m
          where m.tree operator(public.~) _query
        )
        select
          public.subltree(matched.tree, 0, i) as tree
        , pg_catalog.count(matched.id) as count
        from matched
        cross join lateral pg_catalog.generate_series(1, public.nlevel(matched.tree)) i
        group by 1
        order by 1
      $function$
    `,
    {
      spanName: "createListTreeFunction",
      dbOperationName: "CREATE",
      namespace: indexSchema,
    },
  );
}
