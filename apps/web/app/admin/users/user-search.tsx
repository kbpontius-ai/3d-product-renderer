export function UserSearch({ initial }: { initial: string }) {
  return (
    <form className="admin-inline-form" action="/admin">
      <input
        name="q"
        defaultValue={initial}
        placeholder="Find a person by email…"
        aria-label="Find a person by email"
        data-testid="user-search"
      />
      <button type="submit">Find person</button>
    </form>
  );
}
