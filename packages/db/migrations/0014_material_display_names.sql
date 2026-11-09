-- Rename display labels without changing material identifiers or shading.
select set_config('app.is_staff', 'on', true);
update materials
set name = case key when 'pp-matte' then 'Matte' else 'Glossy' end,
    definition = jsonb_set(definition, '{name}', to_jsonb(case key when 'pp-matte' then 'Matte' else 'Glossy' end))
where key in ('pp-matte', 'pp-gloss');

update product_packs as pack
set manifest = jsonb_set(manifest, '{materials}', (
  select jsonb_agg(case material->>'key'
    when 'pp-matte' then jsonb_set(material, '{name}', '"Matte"'::jsonb)
    when 'pp-gloss' then jsonb_set(material, '{name}', '"Glossy"'::jsonb)
    else material end order by ordinal)
  from jsonb_array_elements(pack.manifest->'materials') with ordinality as items(material, ordinal)
))
where jsonb_array_length(manifest->'materials') > 0;

-- Pack digests must describe the rewritten manifest, not the removed material library.
create or replace function pg_temp.pp_canonical_json(value jsonb) returns text
language plpgsql as $$
declare result text;
begin
  case jsonb_typeof(value)
    when 'object' then
      select '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || pg_temp.pp_canonical_json(element), ',' order by key collate "C"), '') || '}'
        into result from jsonb_each(value) as entries(key, element);
    when 'array' then
      select '[' || coalesce(string_agg(pg_temp.pp_canonical_json(element), ',' order by ordinal), '') || ']'
        into result from jsonb_array_elements(value) with ordinality as entries(element, ordinal);
    when 'number' then
      result := value::text;
      if position('.' in result) > 0 and position('e' in result) = 0 then
        result := rtrim(rtrim(result, '0'), '.');
      end if;
    else result := value::text;
  end case;
  return result;
end;
$$;
update product_packs set digest = sha256(convert_to(pg_temp.pp_canonical_json(manifest), 'UTF8'));
