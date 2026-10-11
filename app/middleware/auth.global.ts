export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useUserSession();
  const target = authRedirect(to, loggedIn.value);
  if (target) return navigateTo(target);
});
