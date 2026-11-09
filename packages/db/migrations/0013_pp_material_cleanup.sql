-- Deliberately replace legacy finishes; the approved cleanup applies to saved history too.
select set_config('app.is_staff', 'on', true);

create or replace function pg_temp.pp_material_references(value jsonb) returns jsonb
language plpgsql as $$
declare result jsonb; item record;
begin
  if jsonb_typeof(value) = 'array' then
    select coalesce(jsonb_agg(pg_temp.pp_material_references(element) order by ordinal), '[]'::jsonb)
      into result from jsonb_array_elements(value) with ordinality as items(element, ordinal);
    return result;
  elsif jsonb_typeof(value) = 'object' then
    result := '{}'::jsonb;
    for item in select * from jsonb_each(value) loop
      if item.key in ('materialKey', 'defaultMaterialKey', 'inkMaterialKey') then
        result := result || jsonb_build_object(item.key,
          case when item.value #>> '{}' in ('pp-gloss', 'pp-pearl') then 'pp-gloss' else 'pp-matte' end);
      else
        result := result || jsonb_build_object(item.key, pg_temp.pp_material_references(item.value));
      end if;
    end loop;
    if value ? 'defaultMaterialKey' then
      result := result || '{"allowedFamilies":["plastic"],"allowedFinishes":[]}'::jsonb;
    end if;
    if value->>'kind' in ('emboss','deboss') and value ? 'inkMaterialKey' then
      result := result - 'tintHex';
    end if;
    return result;
  end if;
  return value;
end;
$$;

update design_versions set document = pg_temp.pp_material_references(document);
update product_variants set material_slots = pg_temp.pp_material_references(material_slots);
update product_packs set manifest = jsonb_set(pg_temp.pp_material_references(manifest), '{materials}', '[{"key": "pp-matte", "name": "PP matte", "family": "plastic", "finish": "matte", "colorizable": true, "base": {"baseColorHex": "#1b4d3e", "roughness": 0.62, "metallic": 0, "ior": 1.49, "specular": 0.45, "clearcoat": 0, "clearcoatRoughness": 0.05, "sheen": 0, "transmission": 0, "thicknessMm": 0, "emissiveStrength": 0}, "version": 1, "maps": {"tilingMm": 50}, "mapping": {"three": {}, "cycles": {}}}, {"key": "pp-gloss", "name": "PP glossy", "family": "plastic", "finish": "pearlescent", "colorizable": true, "base": {"baseColorHex": "#dfe4ea", "roughness": 0.28, "metallic": 0, "ior": 1.49, "specular": 0.55, "clearcoat": 0.55, "clearcoatRoughness": 0.1, "sheen": 0.35, "transmission": 0, "thicknessMm": 0, "emissiveStrength": 0}, "version": 1, "maps": {"tilingMm": 50}, "mapping": {"three": {}, "cycles": {}}}]'::jsonb);

update materials set name = 'PP matte', family = 'plastic', status = 'published',
  definition = '{"key": "pp-matte", "name": "PP matte", "family": "plastic", "finish": "matte", "colorizable": true, "base": {"baseColorHex": "#1b4d3e", "roughness": 0.62, "metallic": 0, "ior": 1.49, "specular": 0.45, "clearcoat": 0, "clearcoatRoughness": 0.05, "sheen": 0, "transmission": 0, "thicknessMm": 0, "emissiveStrength": 0}, "version": 1, "maps": {"tilingMm": 50}, "mapping": {"three": {}, "cycles": {}}}'::jsonb where key = 'pp-matte';
insert into materials (id, key, name, family, definition, status)
select '6d8bbb77-3394-4c9e-bcc9-f58af0cdcd15', 'pp-matte', 'PP matte', 'plastic', '{"key": "pp-matte", "name": "PP matte", "family": "plastic", "finish": "matte", "colorizable": true, "base": {"baseColorHex": "#1b4d3e", "roughness": 0.62, "metallic": 0, "ior": 1.49, "specular": 0.45, "clearcoat": 0, "clearcoatRoughness": 0.05, "sheen": 0, "transmission": 0, "thicknessMm": 0, "emissiveStrength": 0}, "version": 1, "maps": {"tilingMm": 50}, "mapping": {"three": {}, "cycles": {}}}'::jsonb, 'published'
where not exists (select 1 from materials where key = 'pp-matte' and org_id is null);

update materials set name = 'PP glossy', family = 'plastic', status = 'published',
  definition = '{"key": "pp-gloss", "name": "PP glossy", "family": "plastic", "finish": "pearlescent", "colorizable": true, "base": {"baseColorHex": "#dfe4ea", "roughness": 0.28, "metallic": 0, "ior": 1.49, "specular": 0.55, "clearcoat": 0.55, "clearcoatRoughness": 0.1, "sheen": 0.35, "transmission": 0, "thicknessMm": 0, "emissiveStrength": 0}, "version": 1, "maps": {"tilingMm": 50}, "mapping": {"three": {}, "cycles": {}}}'::jsonb where key = 'pp-gloss';
insert into materials (id, key, name, family, definition, status)
select 'a6243325-9441-47f6-b3f8-4555287bcebe', 'pp-gloss', 'PP glossy', 'plastic', '{"key": "pp-gloss", "name": "PP glossy", "family": "plastic", "finish": "pearlescent", "colorizable": true, "base": {"baseColorHex": "#dfe4ea", "roughness": 0.28, "metallic": 0, "ior": 1.49, "specular": 0.55, "clearcoat": 0.55, "clearcoatRoughness": 0.1, "sheen": 0.35, "transmission": 0, "thicknessMm": 0, "emissiveStrength": 0}, "version": 1, "maps": {"tilingMm": 50}, "mapping": {"three": {}, "cycles": {}}}'::jsonb, 'published'
where not exists (select 1 from materials where key = 'pp-gloss' and org_id is null);

delete from materials where key not in ('pp-matte', 'pp-gloss');

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
