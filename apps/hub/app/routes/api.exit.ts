// Exits the process so the container runtime restarts it.
export async function loader() {
  setTimeout(() => {
    process.exit(0);
  }, 100); // lets the response go out first

  return new Response(
    JSON.stringify({ message: 'Process will exit shortly' }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );
}
